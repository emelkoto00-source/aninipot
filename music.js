import { createRequire } from "node:module";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { createListeningStats } from "./music_stats.js";

// Temporary YouTube-only replacement for bebot's existing Shoukaku music manager.
// Extractor and relay code is from the user's uploaded MIT-licensed MusicBot/Beatra.
// No SoundCloud auto-fallback: source failures must be visible during this test.
const require = createRequire(import.meta.url);

export function createMusicManager(client) {
  let distube = null;
  let initialization = null;
  let startupError = null;
  const idleTimers = new Map();
  const stayConnected = new Set();
  const autoplayPreferences = new Map();
  const stats = createListeningStats(client, () => distube);

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
      console.log("[DisTube trial] Executables ready. YouTube fallback: DISABLED.");
      const { DisTube, Events } = require("distube");
      const { YouTubePlugin } = require("./beatra_engine/src/music/plugins.js");
      const instance = new DisTube(client, {
        plugins: [new YouTubePlugin({ fallback: null })],
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
    if (!query) return interaction.reply({ content: "Please provide a YouTube URL or song title.", ephemeral: true });
    if (/^https?:\/\//i.test(query)) {
      let hostname = "";
      try { hostname = new URL(query).hostname.toLowerCase(); } catch { /* invalid URL */ }
      if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"].includes(hostname)) {
        return interaction.reply({ content: "During this test, `/play` accepts **YouTube URLs or song titles only**. Spotify/SoundCloud will be added after the audio test succeeds.", ephemeral: true });
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
        .setColor(0x5865f2)
        .setTitle("🎵 DisTube Playback Test")
        .setDescription(song?.url ? `[${song.name}](${song.url})` : (song?.name || "Music request submitted"))
        .addFields({ name: "Source", value: "YouTube via yt-dlp (SoundCloud fallback OFF)" })
        .setFooter({ text: "Confirm that audio plays to the end; check Railway logs if it fails." });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("[DisTube trial] /play error:", redact(error));
      await interaction.editReply(`❌ Music test failed: ${redact(error)}\nNo SoundCloud preview was substituted.`);
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
