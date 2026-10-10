const tokens = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\bofficial\b|\baudio\b|\blyrics?\b|\bvideo\b/g, '').match(/[\p{L}\p{N}]+/gu) || [];
const variants = ['cover', 'remix', 'live', 'karaoke', 'instrumental', 'sped', 'slowed', 'nightcore', 'tribute', 'mashup', 'medley'];

export function matchesAlternative(query, candidate, expected) {
  if (!candidate || !Number.isFinite(candidate.duration) || candidate.duration < 60) return false;
  const wanted = tokens(expected?.name || query);
  const title = tokens(candidate.name);
  const actual = new Set([...title, ...tokens(candidate.uploader?.name)]);
  if (wanted.length < 2 && !expected?.artist) return false; // Ambiguous one-word searches fail closed.
  if (!wanted.every(t => actual.has(t))) return false;
  if (variants.some(t => title.includes(t) && !wanted.includes(t))) return false;
  if (expected?.artist) {
    const artist = tokens(expected.artist).filter(t => t !== 'topic' && t !== 'vevo');
    if (!artist.length || !artist.every(t => actual.has(t))) return false;
  }
  if (expected?.duration > 0 && Math.abs(candidate.duration - expected.duration) > Math.max(5, expected.duration * .05)) return false;
  return true;
}

export function bounded(task, signal, timeoutMs = 30_000) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('Music source timed out')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return task(); }).then(value => signal?.aborted ? finish(signal.reason) : finish(null, value), error => finish(error));
  });
}

export function configureSoundCloud(soundcloud, { relayStream, proxyFor }) {
  const search = soundcloud.searchSong.bind(soundcloud);
  soundcloud.searchSong = async (query, options = {}) => {
    // DisTube also walks extractor plugins on a null search result. Only the
    // explicitly configured YouTube fallback may authorize this search.
    if (options.metadata?.allowFallback !== true) return null;
    const candidate = await bounded(() => search(query, options), options.metadata?.signal);
    return matchesAlternative(query, candidate, options.metadata?.fallbackExpected) ? candidate : null;
  };
  soundcloud.getStreamURL = async song => {
    const signal = song._bebotSignal || song.metadata?.signal;
    const util = soundcloud.soundcloud.util;
    const track = await bounded(() => util.resolveTrack(song.url), signal);
    // Fail closed on unknown/full-length access. A long Song.duration alone is not enough.
    if (track.policy !== 'ALLOW' || track.streamable === false || track.drm || track.is_drm || track.encrypted) throw new Error('SoundCloud source is protected or unavailable');
    const duration = Number(track.full_duration || track.duration);
    const formats = (track.media?.transcodings || []).filter(t =>
      !t.drm && !t.is_drm && !t.encrypted && t.snipped === false && ['hls', 'progressive'].includes(t.format?.protocol) &&
      !/drm|encrypted|preview|snip/i.test(`${t.preset || ''} ${t.url || ''}`) &&
      duration > 0 && Number(t.duration) >= duration - Math.max(5000, duration * .05));
    if (!formats.length) throw new Error('SoundCloud offers no confirmed full-length, unprotected stream (preview or unavailable)');
    const url = await bounded(() => util.getStreamLink(formats[0]), signal);
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /(?:\/|%2f)preview(?:\/|%2f|\?|$)|[?&]type=preview/i.test(url)) {
      throw new Error('SoundCloud returned a preview or unsupported media URL');
    }
    signal?.throwIfAborted();
    return relayStream(soundcloud.relay, { url, signal, proxy: proxyFor(song.metadata?.guildId), attemptId: song.metadata?.attemptId || song.metadata?.requestId });
  };
  return soundcloud;
}
