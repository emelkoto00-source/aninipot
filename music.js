import { createRequire } from "node:module";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

// Temporary YouTube-only replacement for bebot's existing Shoukaku music manager.
// Extractor and relay code is from the user's uploaded MIT-licensed MusicBot/Beatra.
// No SoundCloud auto-fallback: source failures must be visible during this test.
const require = createRequire(import.meta.url);

export function createMusicManager(client) {
  let distube = null;
  let initialization = null;
  let startupError = null;
  const idleTimers = new Map();

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
      if (queue) await queue.stop();
      player.voices.leave(interaction.guildId);
      return interaction.editReply("⏹️ Stopped music and disconnected.");
    } catch (error) {
      console.error("[DisTube trial] /stop error:", redact(error));
      return interaction.editReply(`❌ Could not stop playback: ${redact(error)}`);
    }
  }

  return { init, logStatus, play, stop };
}
