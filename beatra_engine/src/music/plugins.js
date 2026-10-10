'use strict';

const { ExtractorPlugin, PlayableExtractorPlugin, Playlist, Song, DisTubeError } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { DirectLinkPlugin } = require('@distube/direct-link');
const config = require('../config');
const ytdlp = require('./ytdlp');
const { getRelay } = require('./relay');
const { TTLCache } = require('../core/cache');
const log = require('../core/logger').createLogger('extractor');
const { classify, event: diagnostic } = require('../core/diagnostics');
const { RecentTracks } = require('./recommendations');

const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio/best';
const YOUTUBE_HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be',
    'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const VIDEO_ID = /^[\w-]{11}$/;
const BLOCKED_AFTER_FAILURES = 3;
const BLOCKED_PAUSE_MS = 10 * 60_000;

// Every song carries its guild id in metadata so proxy selection never depends on a cached member.
const guildIdOf = (holder) => holder?.metadata?.guildId || holder?.member?.guild?.id || null;
const signalOf = holder => holder?._bebotSignal || holder?.metadata?.signal;

/**
 * Seconds until a googlevideo URL expires (minus a safety margin), capped to 4 hours.
 */
function streamTtl(url) {
    try {
        const expire = Number(new URL(url).searchParams.get('expire'));
        if (expire > 0) return Math.max(0, Math.min(4 * 3600_000, expire * 1000 - Date.now() - 30 * 60_000));
    } catch {
        // not a URL with an expiry
    }
    return 3600_000;
}

/**
 * Classify a YouTube URL: { type: 'video', id } | { type: 'playlist', id } | null.
 */
function parseYouTubeUrl(input) {
    let url;
    try {
        url = new URL(input);
    } catch {
        return null;
    }
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

    const list = url.searchParams.get('list');
    let videoId = url.searchParams.get('v');
    if (url.hostname.endsWith('youtu.be')) videoId = url.pathname.slice(1).split('/')[0];
    const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
    if (pathMatch) videoId = pathMatch[1];

    const hasVideo = Boolean(videoId && VIDEO_ID.test(videoId));
    // Auto-generated mixes (RD...) are endless; when a video is given, play just that video.
    const isMix = Boolean(list && list.startsWith('RD'));
    if (list && /^[\w-]+$/.test(list) && !(isMix && hasVideo)) return { type: 'playlist', id: list };
    if (hasVideo) return { type: 'video', id: videoId };
    return null;
}

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const thumbnailFor = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/**
 * Normalize a yt-dlp info object (full or flat entry) to the fields DisTube's Song wants.
 */
function youtubeInfo(info) {
    const id = info.id;
    const isLive = Boolean(info.is_live || info.live_status === 'is_live');
    return {
        source: 'youtube',
        playFromSource: true,
        id,
        name: info.title || info.fulltitle || id,
        url: VIDEO_ID.test(id || '') ? watchUrl(id) : info.webpage_url || info.url,
        isLive,
        duration: isLive ? 0 : Number(info.duration) || 0,
        thumbnail: VIDEO_ID.test(id || '') ? thumbnailFor(id) : info.thumbnail,
        uploader: {
            name: info.uploader || info.channel || undefined,
            url: info.uploader_url || info.channel_url || undefined,
        },
        views: info.view_count,
        likes: info.like_count,
        ageRestricted: Number(info.age_limit) >= 18,
    };
}

/**
 * Hand a stream to ffmpeg through the local relay, after checking that audio really arrives.
 */
async function relayStream(relay, source) {
    const url = await relay.register(source);
    try { return await relay.warm(url); }
    catch (error) { relay.discard?.(url); throw error; }
}

/**
 * Shared yt-dlp plumbing: caches the extracted info (with its chosen audio format) per proxy,
 * because YouTube locks stream URLs to the IP address that requested them.
 */
class YtDlpBase {
    constructor(runner, relay) {
        this.run = runner;
        this.relay = relay;
        this.infos = new TTLCache({ ttlMs: 3600_000, maxSize: 500 });
    }

    infoKey(guildId, url) {
        return `${ytdlp.proxyFor(guildId) || 'direct'}|${url}`;
    }

    rememberInfo(guildId, pageUrl, info) {
        if (info?.url && info.format_id && !info.entries) this.infos.set(this.infoKey(guildId, pageUrl), info, streamTtl(info.url));
    }

    /**
     * Full info of a song with its audio format chosen (cached, or extracted now).
     */
    async streamInfo(song, { priority = 'high' } = {}) {
        signalOf(song)?.throwIfAborted();
        if (!song?.url) throw new DisTubeError('INVALID_SONG', 'Cannot get a stream without a song URL.');
        const guildId = guildIdOf(song);
        const key = this.infoKey(guildId, song.url);
        const info = await this.infos.wrap(key, async () => {
            const result = await this.run(song.url, ['--no-playlist', '-f', AUDIO_FORMAT], { proxy: ytdlp.proxyFor(guildId), priority, signal: signalOf(song) });
            if (!result?.url) throw new DisTubeError('NO_STREAM_URL', song.name || song.url);
            return result;
        });
        this.infos.set(key, info, streamTtl(info.url));
        signalOf(song)?.throwIfAborted();
        if (song.exactVideoId && info.id !== song.exactVideoId) throw new DisTubeError('INVALID_SONG', 'Video identity did not match the requested link');
        return info;
    }

    async streamUrl(song) {
        const info = await this.streamInfo(song);
        try {
            return await relayStream(this.relay, { info, proxy: ytdlp.proxyFor(guildIdOf(song)),
                signal: signalOf(song), attemptId: song.metadata?.attemptId || song.metadata?.requestId });
        } catch (error) {
            this.infos.delete(this.infoKey(guildIdOf(song), song.url));
            throw error;
        }
    }
}

class YouTubePlugin extends ExtractorPlugin {
    /**
     * @param {object} [options]
     * @param {object} [options.fallback] SoundCloud plugin used when YouTube fails (null to disable).
     */
    constructor({ runner = ytdlp.runJson, relay = getRelay(), fallback = null,
        recommendations = new RecentTracks(), getQueue = () => undefined } = {}) {
        super();
        this.base = new YtDlpBase(runner, relay);
        this.fallback = fallback;
        this.recommendations = recommendations;
        this.getQueue = getQueue;
        this.rejectedRecommendations = new TTLCache({ ttlMs: 10 * 60_000, maxSize: 1000 });
        // When YouTube refuses streams again and again (blocked server IP), stop trying it first
        // for a while so every song does not pay for a failed attempt.
        this.streamFailures = 0;
        this.skipYouTubeUntil = 0;
        this.searches = new TTLCache({ ttlMs: 30 * 60_000, maxSize: 1000 });
        this.lastSearchError = null;
        this.lastSearchErrorAt = 0;
    }

    get run() {
        return this.base.run;
    }

    validate(url) {
        return parseYouTubeUrl(url) !== null;
    }

    async resolve(url, options = {}) {
        signalOf(options)?.throwIfAborted();
        const parsed = parseYouTubeUrl(url);
        if (!parsed) throw new DisTubeError('NOT_SUPPORTED_URL');
        const guildId = guildIdOf(options);
        const proxy = ytdlp.proxyFor(guildId);

        if (parsed.type === 'playlist') {
            const info = await this.run(`https://www.youtube.com/playlist?list=${parsed.id}`, [
                '--flat-playlist', '--playlist-end', String(config.bot.maxPlaylistSize),
            ], { proxy, signal: signalOf(options) });
            signalOf(options)?.throwIfAborted();
            const songs = (info.entries || [])
                .filter((entry) => entry?.id && VIDEO_ID.test(entry.id) && entry.title !== '[Private video]' && entry.title !== '[Deleted video]')
                .map((entry) => new Song({ ...youtubeInfo(entry), plugin: this }, options));
            if (!songs.length) throw new DisTubeError('EMPTY_PLAYLIST');
            return new Playlist({
                source: 'youtube',
                songs,
                id: parsed.id,
                name: info.title || 'YouTube playlist',
                url: `https://www.youtube.com/playlist?list=${parsed.id}`,
                thumbnail: songs[0].thumbnail,
            }, options);
        }

        // One call returns metadata *and* the stream URL, so playback can start right away.
        const info = await this.run(watchUrl(parsed.id), ['--no-playlist', '-f', AUDIO_FORMAT], { proxy, signal: signalOf(options) });
        signalOf(options)?.throwIfAborted();
        if (info?.id !== parsed.id) throw new DisTubeError('INVALID_SONG', 'Video identity did not match the requested link');
        const song = new Song({ ...youtubeInfo(info), plugin: this }, options);
        song.exactVideoId = parsed.id;
        this.base.rememberInfo(guildId, song.url, info);
        return song;
    }

    /**
     * Used by DisTube for text queries and for Spotify tracks (which are played from YouTube).
     * When YouTube fails, the same search runs on SoundCloud; the song is marked so the user is
     * told, and the reason is logged for the bot owner.
     */
    async searchSong(query, options = {}) {
        const guildId = guildIdOf(options);
        let info;
        try {
            info = await this.searchInfo(query, guildId, { signal: signalOf(options) });
        } catch (error) {
            if (signalOf(options)?.aborted) throw signalOf(options).reason;
            this.lastSearchError = error;
            this.lastSearchErrorAt = Date.now();
            diagnostic('metadata_provider_error', { attemptId: options.metadata?.attemptId, source: 'youtube',
                stage: 'metadata_lookup', outcome: 'failed', reason: classify(error) });
            const alternative = await this.#fallbackSearch(query, options);
            if (alternative) return alternative;
            throw error;
        }
        signalOf(options)?.throwIfAborted();
        if (!info) return this.#fallbackSearch(query, options);
        const song = new Song({ ...youtubeInfo(info), plugin: this }, options);
        this.base.rememberInfo(guildId, song.url, info);
        return song;
    }

    async #fallbackSearch(query, options) {
        if (!this.fallback) return null;
        try {
            const song = await this.fallback.searchSong(query, { ...options,
                metadata: { ...options.metadata, allowFallback: true } });
            if (!song) return null;
            song.fallbackFrom = 'youtube';
            log.warn('SoundCloud alternative resolved; audio has not started yet');
            return song;
        } catch (error) {
            log.warn(`SoundCloud fallback unavailable: ${classify(error)}`);
            return null;
        }
    }

    searchInfo(query, guildId, { priority = 'high', signal } = {}) {
        signal?.throwIfAborted();
        const proxy = ytdlp.proxyFor(guildId);
        return this.searches.wrap(`${proxy || 'direct'}|${query.toLowerCase()}`, async () => {
            const result = await this.run(`ytsearch1:${query}`, ['-f', AUDIO_FORMAT], { proxy, priority, signal });
            signal?.throwIfAborted();
            const info = result?.entries ? result.entries.find(Boolean) : result;
            return info?.id ? info : null;
        });
    }

    /**
     * Several results for /search (metadata only, fast flat extraction).
     */
    async search(query, limit = 5, guildId = null) {
        const result = await this.run(`ytsearch${limit}:${query}`, ['--flat-playlist'], { proxy: ytdlp.proxyFor(guildId) });
        return (result?.entries || []).filter((entry) => entry?.id && VIDEO_ID.test(entry.id)).map(youtubeInfo);
    }

    /**
     * Stream of a YouTube song through the relay. If YouTube refuses it (403, bot check, removed),
     * the same song is played from SoundCloud when possible.
     */
    async getStreamURL(song) {
        signalOf(song)?.throwIfAborted();
        // DisTube asks the plugin that answered the search; a SoundCloud fallback song plays through its own plugin.
        if (song.plugin && song.plugin !== this) return song.plugin.getStreamURL(song);
        try {
            if (!song.exactVideoId && this.fallback && Date.now() < this.skipYouTubeUntil) {
                throw new Error('YouTube streams are paused after repeated failures');
            }
            const url = await this.base.streamUrl(song);
            this.streamFailures = 0;
            return url;
        } catch (error) {
            if (signalOf(song)?.aborted) throw signalOf(song).reason;
            // A cached search contains signed media too. Never reuse it after a failed stream.
            this.searches.clear();
            if (song.exactVideoId) throw error;
            if (!this.fallback) throw error;
            if (Date.now() >= this.skipYouTubeUntil && ++this.streamFailures >= BLOCKED_AFTER_FAILURES) {
                this.streamFailures = 0;
                this.skipYouTubeUntil = Date.now() + BLOCKED_PAUSE_MS;
                log.warn(`YouTube failed ${BLOCKED_AFTER_FAILURES} streams: temporarily using explicitly enabled alternatives`);
            }
            log.warn(`YouTube stream failed: ${classify(error)}`);
            const query = [song.name, song.uploader?.name].filter(Boolean).join(' ');
            const alternative = await this.#fallbackSearch(query, { metadata: { ...song.metadata,
                signal: signalOf(song), fallbackExpected: { name: song.name, artist: song.uploader?.name, duration: song.duration } }, member: song.member });
            if (!alternative) throw error;
            const url = await this.fallback.getStreamURL(alternative);
            signalOf(song)?.throwIfAborted();
            // Queue, announcements, statistics and recommendations must describe actual audio.
            for (const key of ['id', 'name', 'source', 'url', 'duration', 'formattedDuration', 'thumbnail', 'uploader', 'isLive']) song[key] = alternative[key];
            song.plugin = this.fallback;
            song.fallbackFrom = 'youtube';
            return url;
        }
    }

    /**
     * Resolve an upcoming song ahead of time so it starts instantly (no download yet).
     */
    async prefetch(song) {
        await this.base.streamInfo(song, { priority: 'low' });
    }

    async prefetchQuery(query, guildId) {
        const info = await this.searchInfo(query, guildId, { priority: 'low' });
        if (info) this.base.rememberInfo(guildId, watchUrl(info.id), info);
    }

    async getRelatedSongs(song) {
        signalOf(song)?.throwIfAborted();
        if (!VIDEO_ID.test(song?.id || '')) return [];
        const guildId = guildIdOf(song);
        const result = await this.run(`${watchUrl(song.id)}&list=RD${song.id}`, [
            '--flat-playlist', '--playlist-end', '40',
        ], { proxy: ytdlp.proxyFor(guildId), priority: 'low', signal: signalOf(song) });
        signalOf(song)?.throwIfAborted();
        const candidates = (result?.entries || [])
            .filter((entry) => entry?.id && entry.id !== song.id && VIDEO_ID.test(entry.id))
            .filter((entry) => !entry.duration || (entry.duration >= 60 && entry.duration <= 900))
            .map((entry) => new Song({ ...youtubeInfo(entry), plugin: this }, { member: song.member, metadata: song.metadata }));
        const fresh = this.recommendations.select(guildId, candidates, song, this.getQueue(guildId))
            .filter(candidate => !this.rejectedRecommendations.has(`${guildId}|${candidate.id}`));
        // Flat mix entries prove only that a video exists, not that its audio
        // can be retrieved. Check a bounded number before DisTube selects one.
        // This applies ONLY to autoplay, never to an explicit video request.
        for (const candidate of fresh.slice(0, 3)) {
            signalOf(song)?.throwIfAborted();
            const timeout = AbortSignal.timeout(8000);
            const parent = signalOf(song);
            const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
            const fields = { source: 'youtube', stage: 'autoplay_candidate' };
            try {
                const info = await this.run(watchUrl(candidate.id), ['--no-playlist', '-f', AUDIO_FORMAT],
                    { proxy: ytdlp.proxyFor(guildId), priority: 'low', signal, timeoutMs: 8000 });
                signal.throwIfAborted();
                if (info?.id !== candidate.id || !info?.url || !info?.format_id) {
                    throw new DisTubeError('NO_STREAM_URL', 'Autoplay candidate has no confirmed audio format');
                }
                const selected = new Song({ ...youtubeInfo(info), plugin: this }, { member: song.member, metadata: song.metadata });
                if (selected.isLive || selected.duration < 60 || selected.duration > 900 ||
                    !this.recommendations.select(guildId, [selected], song, this.getQueue(guildId)).length) continue;
                this.base.rememberInfo(guildId, selected.url, info);
                diagnostic('playback', { ...fields, outcome: 'resolved' });
                return [selected];
            } catch (error) {
                parent?.throwIfAborted();
                this.rejectedRecommendations.set(`${guildId}|${candidate.id}`, true);
                diagnostic('playback', { ...fields, outcome: 'failed', reason: classify(error) });
            }
        }
        return [];
    }
}

/**
 * Fallback for every other site yt-dlp supports (Bandcamp, Vimeo, Twitch, ...). Must be the last plugin.
 */
class GenericPlugin extends PlayableExtractorPlugin {
    constructor({ runner = ytdlp.runJson, relay = getRelay() } = {}) {
        super();
        this.base = new YtDlpBase(runner, relay);
    }

    validate(url) {
        try {
            return ['http:', 'https:'].includes(new URL(url).protocol);
        } catch {
            return false;
        }
    }

    async resolve(url, options = {}) {
        const guildId = guildIdOf(options);
        const info = await this.base.run(url, [
            '--flat-playlist', '--playlist-end', String(config.bot.maxPlaylistSize), '-f', 'bestaudio/best',
        ], { proxy: ytdlp.proxyFor(guildId) });

        const toSong = (entry) => new Song({
            source: entry.extractor_key || entry.ie_key || entry.extractor || 'generic',
            playFromSource: true,
            id: String(entry.id ?? entry.url),
            name: entry.title || entry.id || entry.url,
            url: entry.webpage_url || entry.url,
            isLive: Boolean(entry.is_live),
            duration: entry.is_live ? 0 : Number(entry.duration) || 0,
            thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url,
            uploader: { name: entry.uploader || entry.channel, url: entry.uploader_url || entry.channel_url },
            ageRestricted: Number(entry.age_limit) >= 18,
            plugin: this,
        }, options);

        if (Array.isArray(info.entries)) {
            const songs = info.entries.filter((entry) => entry && (entry.webpage_url || entry.url)).map(toSong);
            if (!songs.length) throw new DisTubeError('EMPTY_PLAYLIST');
            return new Playlist({
                source: info.extractor_key || 'generic',
                songs,
                id: String(info.id ?? url),
                name: info.title || url,
                url: info.webpage_url || url,
                thumbnail: info.thumbnail || songs[0].thumbnail,
            }, options);
        }

        const song = toSong(info);
        this.base.rememberInfo(guildId, song.url, info);
        return song;
    }

    getStreamURL(song) {
        return this.base.streamUrl(song);
    }

    async prefetch(song) {
        await this.base.streamInfo(song, { priority: 'low' });
    }

    getRelatedSongs() {
        return [];
    }
}

/**
 * SoundCloud and direct links also play through the relay, so ffmpeg never opens network
 * connections itself (proxies apply and static ffmpeg builds work on Linux).
 */
class RelayedSoundCloudPlugin extends SoundCloudPlugin {
    constructor({ relay = getRelay(), ...options } = {}) {
        super(options);
        this.relay = relay;
    }

    async getStreamURL(song) {
        const url = await super.getStreamURL(song);
        return relayStream(this.relay, { url, proxy: ytdlp.proxyFor(guildIdOf(song)) });
    }
}

class RelayedDirectLinkPlugin extends DirectLinkPlugin {
    constructor({ relay = getRelay() } = {}) {
        super();
        this.relay = relay;
    }

    async getStreamURL(song) {
        const url = super.getStreamURL(song);
        return relayStream(this.relay, { url, proxy: ytdlp.proxyFor(guildIdOf(song)) });
    }
}

module.exports = {
    YouTubePlugin, GenericPlugin, RelayedSoundCloudPlugin, RelayedDirectLinkPlugin,
    parseYouTubeUrl, youtubeInfo, streamTtl, relayStream, AUDIO_FORMAT,
};
