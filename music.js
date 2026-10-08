import { createRequire } from "node:module";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { createListeningStats } from "./music_stats.js";

// DisTube music manager. YouTube remains first choice; guarded SoundCloud is an
// alternative only when full-length playback is plausible (no preview URLs).
// The Beatra YouTube extractor, yt-dlp runner and audio relay remain unchanged.
const require = createRequire(import.meta.url);

export function createMusicManager(client) {
  let distube = null;
  let initialization = null;
  let startupError = null;
  const idleTimers = new Map();
  const stayConnected = new Set();
  const autoplayPreferences = new Map();
  // Discord channel used for announcements; separate from the audio pipeline.
  const announcementChannels = new Map();
  const suppressFirstStart = new Set();
  const lastSongAnnouncements = new Map();
  const stats = createListeningStats(client, () => distube);

  // Fail closed on unrelated SoundCloud matches. DisTube's fallback previously
  // accepted its first result, even when requesting "Mine" returned "Wildest Dreams".
  // This is intentionally conservative: when uncertain, do not substitute a song.
  function soundcloudMatch(query, candidate) {
    const normalized = value => String(value || '')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const requested = normalized(query).split(/\s+/).filter(Boolean);
    const uploader = typeof candidate?.uploader === 'string' ? candidate.uploader : candidate?.uploader?.name;
    const title = normalized(candidate?.name);
    const candidateText = normalized(`${candidate?.name || ''} ${uploader || ''}`);
    const actual = new Set(candidateText.split(/\s+/).filter(Boolean));
    if (!requested.length || !title) return false;
    // A prominent title word must occur. Artist/version matches alone are not enough.
    const skip = new Set(['the', 'a', 'an', 'and', 'ft', 'feat', 'featuring',
      'official', 'video', 'audio', 'lyrics', 'lyric', 'music', 'song', 'version']);
    const lead = requested.find(word => !skip.has(word)) || requested[0];
    if (!actual.has(lead)) return false;
    const meaningful = requested.filter(word => !skip.has(word));
    if (meaningful.length > 1) {
      const hits = meaningful.filter(word => actual.has(word)).length;
      if (hits / meaningful.length < 0.65) return false;
    }
    // Do not quietly substitute covers, sped-up edits or karaoke versions.
    for (const qualifier of ['cover', 'karaoke', 'nightcore', 'instrumental', 'remix']) {
      if (title.split(' ').includes(qualifier) && !requested.includes(qualifier)) return false;
    }
    return true;
  }

  function safeTitle(value) {
    return String(value || 'Unknown song').replace(/([\\`*_{}\[\]()#+.!>~-])/g, '\\$1').slice(0, 220);
  }

  async function announceNextSong(queue, song) {
    const guildId = queue?.id;
    if (!guildId || !song) return;
    const cached = queue.textChannel?.send ? queue.textChannel : null;
    const channelId = announcementChannels.get(guildId);
    const channel = cached || (channelId ? await client.channels.fetch(channelId).catch(() => null) : null);
    if (!channel?.send) {
      console.warn(`[DisTube] No text channel available for song announcement in ${guildId}`);
      return;
    }
    const title = safeTitle(song.name);
    const songURL = /^https?:\/\//i.test(String(song.url || '')) ? song.url : null;
    const artist = typeof song.uploader === 'string' ? song.uploader : song.uploader?.name;
    const embed = new EmbedBuilder()
      .setColor(0xED91CF)
      .setTitle('🎵 Now Playing')
      .setDescription(songURL ? `[${title}](${songURL})` : `**${title}**`);
    if (artist) embed.addFields({ name: 'Artist', value: String(artist).slice(0, 160), inline: true });
    if (song.formattedDuration) embed.addFields({ name: 'Duration', value: String(song.formattedDuration), inline: true });
    const imageURL = String(song.thumbnail || '');
    if (/^https?:\/\//i.test(imageURL)) embed.setThumbnail(imageURL);
    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      console.log(`[DisTube] Announced next song in ${guildId}: ${song.name}`);
    } catch (error) {
      console.warn(`[DisTube] Could not announce song in ${guildId}:`, redact(error));
    }
  }

  function redact(error) {
    let msg = String(error?.message || error || "Unknown error");
    for (const secret of [process.env.DISCORD_TOKEN, process.env.PROXY_URL,
      process.env.COOKIES_FILE, process.env.YOUTUBE_PO_TOKEN]) {
      if (secret) msg = msg.split(secret).join("[redacted]");
    }
    // yt-dlp may include signed CDN links; avoid exposing them in Discord messages.
    return msg.replace(/https?:\/\/\S+/g, "[media URL]").slice(0, 650).replaceAll("`", "'");
  }

  function cancelIdle(guildId) {
    if (idleTimers.has(guildId)) clearTimeout(idleTimers.get(guildId));
    idleTimers.delete(guildId);
  }

  function scheduleIdle(guildId) {
    cancelIdle(guildId);
    if (stayConnected.has(guildId)) return;
    const timer = setTimeout(() => {
      idleTimers.delete(guildId);
      try {
        if (!distube?.getQueue(guildId)) distube?.voices.leave(guildId);
      } catch (error) { console.warn("[DisTube trial] Idle leave:", redact(error)); }
    }, 120_000);
    timer.unref?.();
    idleTimers.set(guildId, timer);
  }

  async function init() {
    if (distube) return distube;
    if (initialization) return initialization;
    initialization = (async () => {
      // Download/check both executables BEFORE requiring the yt-dlp runner. The runner
      // resolves its binary path at module load time.
      const { ensureYtDlp, ensureFfmpeg } = require("./beatra_engine/src/core/binaries.js");
      console.log("[DisTube trial] Checking yt-dlp and FFmpeg (first boot may take longer)...");
      const [ytDlpPath, ffmpegPath] = await Promise.all([ensureYtDlp(), ensureFfmpeg()]);
      if (!ytDlpPath || !ffmpegPath) {
        throw new Error("Missing yt-dlp or FFmpeg. See the Railway Deploy Logs for the download error.");
      }
      console.log("[DisTube] Executables ready. YouTube first, SoundCloud preview guard enabled.");
      const { DisTube, Events } = require("distube");
      const { YouTubePlugin, RelayedSoundCloudPlugin, relayStream } = require("./beatra_engine/src/music/plugins.js");
      const { SoundCloudPlugin } = require("@distube/soundcloud");
      const { proxyFor } = require("./beatra_engine/src/music/ytdlp.js");
      // CRITICAL: Beatra's relay is required for SoundCloud too. The plain
      // SoundCloudPlugin returned a remote HLS URL directly to FFmpeg; on some
      // sources FFmpeg would finish immediately without delivering any audio.
      // Keep the full-length preview filter before passing the URL to the relay.
      const soundcloud = new RelayedSoundCloudPlugin();
      const originalSearchSong = soundcloud.searchSong.bind(soundcloud);
      soundcloud.searchSong = async (...args) => {
        const candidate = await originalSearchSong(...args);
        if (!candidate) return null;
        if (Number(candidate.duration) > 0 && Number(candidate.duration) < 60) {
          console.warn('[DisTube] Rejected short SoundCloud result:', candidate.name);
          return null;
        }
        if (!soundcloudMatch(args[0], candidate)) {
          console.warn('[DisTube] Rejected mismatched SoundCloud fallback:',
            JSON.stringify({ requested: String(args[0]).slice(0, 100), found: String(candidate.name || '').slice(0, 100) }));
          return null;
        }
        return candidate;
      };
      // Call the underlying SoundCloud API before the relay wrapper so preview
      // URLs can be rejected, then stream actual bytes through yt-dlp's relay.
      soundcloud.getStreamURL = async song => {
        const result = await SoundCloudPlugin.prototype.getStreamURL.call(soundcloud, song);
        const streamUrl = typeof result === 'string' ? result : (result?.url || '');
        if (typeof streamUrl !== 'string' || !/^https?:\/\//i.test(streamUrl)) {
          throw new Error('SoundCloud did not provide a supported media URL.');
        }
        if (/(?:\/|%2f)preview(?:\/|%2f|\?|$)/i.test(streamUrl) || /(?:[?&]type=preview)/i.test(streamUrl)) {
          console.warn('[DisTube] Rejected preview-only SoundCloud stream:', song?.name || 'unknown');
          throw new Error('SoundCloud provided a preview clip, not the full track.');
        }
        const guildId = song?.metadata?.guildId || song?.member?.guild?.id || null;
        // relayStream waits for media bytes. If the download fails or only
        // returns HTTP 403, /play fails instead of reporting a silent start.
        let relayUrl;
        try {
          relayUrl = await relayStream(soundcloud.relay, { url: streamUrl, proxy: proxyFor(guildId) });
        } catch (error) {
          if (/drm protected|encrypted content|protected by drm/i.test(String(error?.message || error))) {
            throw new Error('SoundCloud offered a DRM-protected stream, which bebot cannot play.');
          }
          throw error;
        }
        console.log(`[DisTube] SoundCloud relay opened: ${String(song?.name || 'track').slice(0, 120)}`);
        return relayUrl;
      };
      const instance = new DisTube(client, {
        plugins: [new YouTubePlugin({ fallback: soundcloud }), soundcloud],
        emitAddSongWhenCreatingQueue: false,
        emitAddListWhenCreatingQueue: false,
        joinNewVoiceChannel: false,
        ffmpeg: {
          path: ffmpegPath,
          args: { input: { reconnect: 0, reconnect_streamed: 0, reconnect_delay_max: null } }
        }
      });
      instance.on(Events.PLAY_SONG, (queue, song) => {
        cancelIdle(queue.id);
        if (autoplayPreferences.has(queue.id) && Boolean(queue.autoplay) !== autoplayPreferences.get(queue.id)) {
          try { queue.toggleAutoplay(); } catch (err) { console.warn('[DisTube] Could not set autoplay:', redact(err)); }
        }
        console.log(`[DisTube trial] Playing in ${queue.id}: ${song.name} (${song.duration}s) [${song.source}]`);
        // /play already sends a response for the first song. Announce subsequent
        // songs (playlist entries, /skip, and autoplay) in the text channel.
        if (suppressFirstStart.delete(queue.id)) return;
        const key = String(song.id || song.url || song.name);
        const previous = lastSongAnnouncements.get(queue.id);
        const now = Date.now();
        if (previous?.key === key && now - previous.at < 10_000) return;
        lastSongAnnouncements.set(queue.id, { key, at: now });
        // PLAY_SONG is not proof that packets reached Discord. Avoid announcing
        // tracks whose queue immediately disappears due to a media/DRM error.
        const announceTimer = setTimeout(() => {
          const active = distube?.getQueue(queue.id);
          const current = active?.songs?.[0];
          if (active === queue && current && String(current.id || current.url || current.name) === key) {
            void announceNextSong(queue, song);
          }
        }, 2500);
        announceTimer.unref?.();
      });
      instance.on(Events.ADD_SONG, (queue, song) => {
        console.log(`[DisTube trial] Queued in ${queue.id}: ${song.name}`);
      });
      instance.on(Events.FINISH, queue => {
        console.log(`[DisTube trial] Queue finished in ${queue.id}`);
        scheduleIdle(queue.id);
      });
      instance.on(Events.DISCONNECT, queue => {
        cancelIdle(queue.id);
        console.warn(`[DisTube trial] Disconnected in ${queue.id}`);
      });
      instance.on(Events.DELETE_QUEUE, queue => {
        console.log(`[DisTube trial] Queue deleted in ${queue.id}`);
        scheduleIdle(queue.id);
      });
      instance.on(Events.ERROR, (error, queue, song) => {
        console.error(`[DisTube trial] Audio failed in ${queue?.id || "unknown"} (${song?.name || "unknown"}): ${redact(error)}`);
      });
      if (String(process.env.DEBUG || "").toLowerCase() === "true") {
        instance.on(Events.DEBUG, msg => console.log("[DisTube debug]", msg));
      }
      distube = instance;
      startupError = null;
      console.log("[DisTube trial] Ready. Lavalink is not used by this build.");
      return instance;
    })().catch(err => {
      startupError = redact(err);
      initialization = null; // retry when /play is next requested
      console.error("[DisTube trial] Startup failure:", startupError);
      throw err;
    });
    return initialization;
  }

  function logStatus() {
    console.log("[DisTube trial] bebot music test enabled. Other commands unchanged.");
    void init().catch(() => {});
  }

  async function play(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: "Use `/play` in your Discord server.", ephemeral: true });
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const voice = member?.voice?.channel;
    if (!voice) return interaction.reply({ content: "🎧 Join a voice channel first.", ephemeral: true });
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const perms = me && voice.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
      return interaction.reply({ content: "bebot needs **Connect** and **Speak** permissions in your voice channel.", ephemeral: true });
    }
    const query = interaction.options.getString("query", true).trim();
    if (!query) return interaction.reply({ content: "Please provide a YouTube/SoundCloud URL or a song title.", ephemeral: true });
    if (/^https?:\/\//i.test(query)) {
      let hostname = "";
      try { hostname = new URL(query).hostname.toLowerCase(); } catch { /* invalid URL */ }
      if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(hostname)) {
        return interaction.reply({ content: "Use a **YouTube or SoundCloud track URL**, or search by song title. Spotify links are not enabled.", ephemeral: true });
      }
    }
    await interaction.deferReply();
    try {
      const player = await init();
      const current = player.getQueue(interaction.guildId);
      if (current && current.voiceChannel?.id !== voice.id) {
        throw new Error("Music is already active in another voice channel. Use `/stop` there first.");
      }
      cancelIdle(interaction.guildId);
      announcementChannels.set(interaction.guildId, interaction.channelId);
      if (!current) suppressFirstStart.add(interaction.guildId);
      console.log(`[DisTube trial] /play requested for guild ${interaction.guildId}: ${query.slice(0, 120)}`);
      await player.play(voice, query, {
        member,
        textChannel: interaction.channel,
        metadata: { guildId: interaction.guildId, requesterId: interaction.user.id }
      });
      const q = player.getQueue(interaction.guildId);
      if (q && autoplayPreferences.has(interaction.guildId) && Boolean(q.autoplay) !== autoplayPreferences.get(interaction.guildId)) {
        q.toggleAutoplay();
      }
      const song = q?.songs?.at(-1);
      const embed = new EmbedBuilder()
        .setColor(0xED91CF)
        .setTitle("🎵 Music Requested")
        .setDescription(song?.url ? `[${song.name}](${song.url})` : (song?.name || "Music request submitted"));
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      suppressFirstStart.delete(interaction.guildId);
      console.error("[DisTube trial] /play error:", redact(error));
      await interaction.editReply(`❌ Unable to play this song: ${redact(error)}\nYouTube may be blocking this server, and no verified full-length alternative was available.`);
    }
  }

  async function stop(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: "Use `/stop` inside your server.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const player = distube;
      if (!player) return interaction.editReply(startupError ? `Audio engine unavailable: ${startupError}` : "No music session is active.");
      const queue = player.getQueue(interaction.guildId);
      const voiceSession = player.voices.get(interaction.guildId);
      if (!queue && !voiceSession) return interaction.editReply("No music session is active.");
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const allowed = member?.voice?.channelId === (queue?.voiceChannel?.id || voiceSession?.channelId) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!allowed) return interaction.editReply("Join the bot's voice channel or have **Manage Server** permission.");
      cancelIdle(interaction.guildId);
      stayConnected.delete(interaction.guildId);
      autoplayPreferences.delete(interaction.guildId);
      suppressFirstStart.delete(interaction.guildId);
      lastSongAnnouncements.delete(interaction.guildId);
      if (queue) await queue.stop();
      player.voices.leave(interaction.guildId);
      return interaction.editReply("⏹️ Stopped music and disconnected.");
    } catch (error) {
      console.error("[DisTube trial] /stop error:", redact(error));
      return interaction.editReply(`❌ Could not stop playback: ${redact(error)}`);
    }
  }

  // Playback controls are isolated from the working yt-dlp extractor and relay.
  async function control(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Use music commands in the Discord server.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const command = interaction.commandName;
    const player = distube;
    const queue = player?.getQueue(interaction.guildId);
    const voiceSession = player?.voices.get(interaction.guildId);
    const channelId = queue?.voiceChannel?.id || voiceSession?.channelId;
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const isManager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    const sameVoice = member?.voice?.channelId && member.voice.channelId === channelId;
    const isListeningAction = !['queue', 'nowplaying'].includes(command);
    if (isListeningAction && channelId && !sameVoice && !isManager) {
      return interaction.editReply('Join my voice channel or have **Manage Server** permission.');
    }
    const reply = text => interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    try {
      if (command === '247') {
        const mode = interaction.options.getString('mode', true);
        if (mode === 'status') return reply(`24/7 mode: **${stayConnected.has(interaction.guildId) ? 'ON' : 'OFF'}**. This setting resets after a bot restart.`);
        if (mode === 'on') {
          if (!channelId || (!sameVoice && !isManager)) return reply('Start `/play` in your voice channel first, then enable `/247 on`.');
          stayConnected.add(interaction.guildId);
          cancelIdle(interaction.guildId);
          return reply('🔒 24/7 mode ON. I will not use the normal 2-minute idle timer. Discord or Railway disconnects may still occur.');
        }
        stayConnected.delete(interaction.guildId);
        if (!queue) scheduleIdle(interaction.guildId);
        return reply('🔓 24/7 mode OFF. Normal idle disconnect restored.');
      }
      if (command === 'autoplay') {
        const mode = interaction.options.getString('mode', true);
        const current = queue ? Boolean(queue.autoplay) : Boolean(autoplayPreferences.get(interaction.guildId));
        if (mode === 'status') return reply(`Autoplay: **${current ? 'ON' : 'OFF'}**`);
        if (!sameVoice && !isManager) return reply('Join the voice channel and start playing a song to change autoplay.');
        const desired = mode === 'on';
        autoplayPreferences.set(interaction.guildId, desired);
        if (queue && current !== desired) queue.toggleAutoplay();
        return reply(`🔁 Autoplay ${desired ? 'enabled' : 'disabled'}. Recommended songs still depend on YouTube availability.`);
      }
      if (command === 'queue') {
        if (!queue?.songs?.length) return reply('📭 The music queue is empty.');
        const page = interaction.options.getInteger('page') || 1;
        const pageSize = 8;
        const pages = Math.max(1, Math.ceil(queue.songs.length / pageSize));
        if (page > pages) return reply(`That page does not exist. Choose a page between 1 and ${pages}.`);
        const lines = queue.songs.slice((page - 1) * pageSize, page * pageSize).map((song,i) => {
          const idx = (page - 1) * pageSize + i;
          const title = String(song.name || 'Unknown').slice(0, 80).replaceAll('`', "'");
          return `${idx === 0 ? '▶️' : `${idx + 1}.`} ${title} (${song.formattedDuration || 'Unknown duration'})`;
        });
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xED91CF).setTitle('🎶 Music Queue').setDescription(lines.join('\n')).setFooter({ text: `Page ${page}/${pages} • ${queue.songs.length} song(s)` })] });
      }
      if (command === 'nowplaying') {
        const song = queue?.songs?.[0];
        if (!song) return reply('Nothing is playing right now.');
        const e = new EmbedBuilder().setColor(0xED91CF).setTitle('🎵 Now Playing').setDescription(song.url ? `[${String(song.name).replaceAll('[','\\[').replaceAll(']','\\]')}](${song.url})` : song.name).addFields({ name: 'Position', value: `${Math.floor(queue.currentTime || 0)}s / ${song.formattedDuration || 'unknown'}` }, { name: 'Queue', value: `${queue.songs.length} song(s)` });
        return interaction.editReply({ embeds: [e] });
      }
      if (!player || (!queue && !['leave','stop'].includes(command))) return reply('No active song. Use `/play` first.');
      if (!channelId && command !== 'leave') return reply('No voice session is active.');
      if (command === 'skip' || command === 'next') {
        if (queue.songs.length <= 1 && !queue.autoplay) {
          await queue.stop();
          scheduleIdle(interaction.guildId);
          return reply('⏭️ Skipped the final track. Queue is now empty.');
        }
        await queue.skip();
        return reply('⏭️ Skipped to the next track.');
      }
      if (command === 'pause') {
        if (queue.paused) return reply('Already paused.');
        await queue.pause(); return reply('⏸️ Paused playback.');
      }
      if (command === 'resume') {
        if (!queue.paused) return reply('Playback is not paused.');
        await queue.resume(); return reply('▶️ Resumed playback.');
      }
      if (command === 'volume') {
        const value = interaction.options.getInteger('level', true);
        queue.setVolume(value); return reply(`🔊 Volume set to **${value}%**.`);
      }
      if (command === 'leave') {
        stayConnected.delete(interaction.guildId);
        autoplayPreferences.delete(interaction.guildId);
        cancelIdle(interaction.guildId);
        if (queue) await queue.stop();
        if (voiceSession) player.voices.leave(interaction.guildId);
        return reply('👋 Left the voice channel.');
      }
      return reply('Unknown music command.');
    } catch (error) {
      console.error(`[DisTube controls] ${command}:`, redact(error));
      return reply(`❌ ${command} failed: ${redact(error)}`);
    }
  }

  return { init, logStatus, play, stop, control, stats };
}
