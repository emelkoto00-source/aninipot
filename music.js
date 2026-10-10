import { createRequire } from "node:module";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { createListeningStats } from "./music_stats.js";
import { MusicSessions } from "./music_session.js";
import { configureSoundCloud } from "./music_sources.js";
import { instrumentMusic } from "./music_runtime.js";

// Music commands retain the existing DisTube engine with cancellable per-guild requests.
const require = createRequire(import.meta.url);

export function createMusicManager(client, { engineFactory, statsFactory = createListeningStats } = {}) {
  let distube = null;
  let initialization = null;
  let startupError = null;
  const idleTimers = new Map();
  const stayConnected = new Set();
  const autoplayPreferences = new Map();
  const stats = statsFactory(client, () => distube);
  const sessions = new MusicSessions();
  const preparing = new Map();
  let runtime;
  let relay;

  const { redact, event: diagnostic, classify } = require("./beatra_engine/src/core/diagnostics.js");

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
      const { Events } = require("distube");
      let instance;
      if (engineFactory) {
        ({ instance, relay } = await engineFactory());
      } else {
        const config = require("./beatra_engine/src/config.js");
        const { ensureYtDlp, ensureFfmpeg, probe } = require("./beatra_engine/src/core/binaries.js");
        const [ytDlpPath, ffmpegPath] = await Promise.all([ensureYtDlp(), ensureFfmpeg()]);
        if (!ytDlpPath || !ffmpegPath) throw new Error("Missing yt-dlp or FFmpeg executable.");
        // Match the checked executable to the path captured when the runner is loaded.
        config.ytdlp.path = ytDlpPath;
        const { DisTube } = require("distube");
        const { YouTubePlugin, RelayedSoundCloudPlugin, relayStream } = require("./beatra_engine/src/music/plugins.js");
        const { proxyFor } = require("./beatra_engine/src/music/ytdlp.js");
        relay = require("./beatra_engine/src/music/relay.js").getRelay();
        const soundcloud = configureSoundCloud(new RelayedSoundCloudPlugin(), { relayStream, proxyFor });
        instance = new DisTube(client, {
          plugins: [new YouTubePlugin({ fallback: config.youtubeFallback ? soundcloud : null }), soundcloud],
          emitAddSongWhenCreatingQueue: false, emitAddListWhenCreatingQueue: false,
          joinNewVoiceChannel: false,
          ffmpeg: { path: ffmpegPath, args: { input: { reconnect: 0, reconnect_streamed: 0, reconnect_delay_max: null } } }
        });
        const [yt, ff] = await Promise.all([probe(ytDlpPath), probe(ffmpegPath, ['-version'])]);
        diagnostic('runtime', { node: process.version, distube: require('distube').version, voice: require('@discordjs/voice').version,
          ytDlp: yt.ok ? yt.output.split(/\r?\n/)[0] : 'unavailable',
          ffmpeg: ff.ok ? ff.output.split(/\r?\n/)[0] : 'unavailable' });
      }
      runtime = instrumentMusic(instance, { sessions, relay, notice: (guildId, content) => {
        const channel = instance.getQueue(guildId)?.textChannel;
        if (channel) void channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
      } });
      instance.on(Events.PLAY_SONG, (queue, song) => {
        cancelIdle(queue.id);
        if (autoplayPreferences.has(queue.id) && Boolean(queue.autoplay) !== autoplayPreferences.get(queue.id)) {
          try { queue.toggleAutoplay(); } catch (err) { console.warn('[DisTube] Could not set autoplay:', redact(err)); }
        }

      });
      instance.on(Events.FINISH, queue => scheduleIdle(queue.id));
      instance.on(Events.DISCONNECT, queue => { cancelIdle(queue.id); sessions.cancel(queue.id); sessions.release(queue.id); });
      instance.on(Events.DELETE_QUEUE, queue => { scheduleIdle(queue.id); sessions.release(queue.id); });
      instance.on(Events.NO_RELATED, queue => diagnostic('playback', { stage: 'recommendations', outcome: 'unavailable' }));
      // Never subscribe raw DEBUG/FFMPEG_DEBUG messages: they contain source URLs/arguments.
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
    if ((preparing.get(interaction.guildId)?.size || 0) >= 10) return interaction.reply({ content: 'Too many music requests are waiting. Please try again shortly.', ephemeral: true });
    const signal = sessions.state(interaction.guildId).controller.signal;
    const request = { userId: interaction.user.id, voiceId: interaction.member?.voice?.channelId };
    if (!preparing.has(interaction.guildId)) preparing.set(interaction.guildId, new Set());
    preparing.get(interaction.guildId).add(request);
    try {
      await interaction.deferReply();
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const voice = member?.voice?.channel;
      request.voiceId = voice?.id;
      signal.throwIfAborted();
      if (!voice) return interaction.editReply({ content: "🎧 Join a voice channel first.", ephemeral: true });
      const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
      const perms = me && voice.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
        return interaction.editReply({ content: "bebot needs **Connect** and **Speak** permissions in your voice channel.", ephemeral: true });
      }
      const query = interaction.options.getString("query", true).trim();
      if (!query) return interaction.editReply({ content: "Please provide a YouTube/SoundCloud URL or a song title.", ephemeral: true });
      if (/^https?:\/\//i.test(query)) {
        let hostname = "";
        try { hostname = new URL(query).hostname.toLowerCase(); } catch { /* invalid URL */ }
        if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(hostname)) {
          return interaction.editReply({ content: "Use a **YouTube or SoundCloud track URL**, or search by song title. Spotify links are not enabled.", ephemeral: true });
        }
      }
      sessions.reserve(interaction.guildId, voice.id);
      const resolved = await sessions.run(interaction.guildId, async () => {
        signal.throwIfAborted();
        const player = await init();
        signal.throwIfAborted();
        const current = player.getQueue(interaction.guildId);
        if (current && current.voiceChannel?.id !== voice.id) throw new Error("Music is already active in another voice channel.");
        cancelIdle(interaction.guildId);
        const options = { member, textChannel: interaction.channel,
          metadata: { guildId: interaction.guildId, requesterId: interaction.user.id, signal } };
        const result = await runtime.resolve(query, options);
        signal.throwIfAborted();
        if ((current?.songs.length || 0) + (result.songs?.length || 1) > 500) throw new Error('The music queue is full.');
        // Metadata is already attached. Passing it again would overwrite per-track attempt IDs.
        try { await player.play(voice, result, { member, textChannel: interaction.channel }); }
        finally { runtime.requestDone(result); }
        signal.throwIfAborted();
        const failure = runtime.errors.get(result.songs?.[0] || result);
        if (failure) throw failure; // DisTube can emit ERROR yet resolve play().
        return result;
      });
      const song = resolved.songs?.[0] || resolved;
      const embed = new EmbedBuilder()
        .setColor(0xED91CF)
        .setTitle("🎵 Music Requested")
        .setDescription(song?.url ? `[${song.name}](${song.url})` : (song?.name || "Music request submitted"));
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      diagnostic('request', { stage: 'command', outcome: 'failed', reason: classify(error) });
      await interaction.editReply({ content: sessions.state(interaction.guildId).controller.signal.aborted || error.name === 'AbortError'
        ? '⏹️ Music request cancelled.' : '❌ This music request could not be completed. Details are in the bot logs.', allowedMentions: { parse: [] } });
    } finally {
      preparing.get(interaction.guildId)?.delete(request);
      if (!preparing.get(interaction.guildId)?.size) preparing.delete(interaction.guildId);
      if (!distube?.getQueue(interaction.guildId) && !distube?.voices.get(interaction.guildId)) sessions.release(interaction.guildId);
    }
  }

  async function stop(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: "Use this command inside your server.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.guildId;
    const queue = distube?.getQueue(id);
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const requests = [...(preparing.get(id) || [])];
    const channelId = queue?.voiceChannel?.id || distube?.voices.get(id)?.channelId || sessions.states.get(id)?.voiceId || requests.find(r => r.voiceId)?.voiceId;
    const ownsUnresolved = !channelId && requests.length && requests.every(r => r.userId === interaction.user.id);
    if (!channelId && !requests.length) return interaction.editReply('No music session is active.');
    if (!ownsUnresolved && (!channelId || member?.voice?.channelId !== channelId) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply("Join the bot's voice channel or have **Manage Server** permission.");
    }
    sessions.cancel(id); // invalidate in-flight and queued requests BEFORE waiting for the lock
    if (queue) runtime?.cancelTrack(queue);
    cancelIdle(id); stayConnected.delete(id); autoplayPreferences.delete(id);
    try {
      await sessions.run(id, async () => {
        const current = distube?.getQueue(id);
        if (current) await current.stop();
        distube?.voices.get(id)?.stream?.kill();
        if (distube?.voices.get(id)) distube.voices.leave(id);
      });
      cancelIdle(id); sessions.release(id);
      return interaction.editReply('⏹️ Stopped music and disconnected.');
    } catch (error) {
      diagnostic('request', { stage: 'stop', outcome: 'failed', reason: classify(error) });
      return interaction.editReply('❌ Could not finish disconnecting. Details are in the bot logs.');
    }
  }

  // Playback controls are isolated from the working yt-dlp extractor and relay.
  async function control(interaction) {
    if (['stop', 'leave'].includes(interaction.commandName)) return stop(interaction);
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
        if (runtime?.pending.has(interaction.guildId)) return reply('The track is still loading. Use `/stop` to cancel it, or try `/skip` after playback starts.');
        const message = await sessions.run(interaction.guildId, async () => {
          const current = player.getQueue(interaction.guildId);
          if (!current || current !== queue) return 'The music session changed. Please try again.';
          // No Idle transition exists yet while extraction is pending. Do not mutate its head.
          if (runtime?.pending.has(interaction.guildId) || !current.voice?.stream || current.voice.audioPlayer?.state.status === 'idle') {
            return 'The track is still loading. Use `/stop` to cancel it, or try `/skip` after playback starts.';
          }
          const previous = current.songs[0];
          const undoCancellation = runtime?.markCancelled(previous);
          try {
            if (current.songs.length <= 1 && !current.autoplay) {
              await current.stop();
              runtime?.cancelSong(previous);
              scheduleIdle(interaction.guildId);
              return '⏭️ Skipped the final track. Queue is now empty.';
            }
            await current.skip();
            runtime?.cancelSong(previous);
            return '⏭️ Skipped to the next track.';
          } catch (error) { undoCancellation?.(); throw error; }
        });
        return reply(message);
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
      return reply('Unknown music command.');
    } catch (error) {
      console.error(`[DisTube controls] ${command}:`, redact(error));
      return reply(`❌ ${command} failed. Details are in the bot logs.`);
    }
  }

  async function close() {
    const draining = sessions.close();
    relay?.close();
    await draining;
    for (const queue of [...(distube?.queues?.collection?.values?.() || [])]) await queue.stop();
    for (const id of sessions.states.keys()) {
      distube?.voices.get(id)?.stream?.kill();
      if (distube?.voices.get(id)) distube.voices.leave(id);
    }
    relay?.close();
    for (const id of idleTimers.keys()) cancelIdle(id);
    runtime?.close();
    await stats.flush?.();
  }
  return { init, logStatus, play, stop, control, stats, close };
}
