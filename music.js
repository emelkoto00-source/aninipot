import { createRequire } from "node:module";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

// DisTube/yt-dlp engine replacing bebot's former Shoukaku music manager.
// Extractor and relay code is from the user's uploaded MIT-licensed MusicBot/Beatra.
// Spotify resolves titles/playlists; YouTube/yt-dlp supplies audio. No SoundCloud fallback.
const require = createRequire(import.meta.url);
const MAX_SPOTIFY_PLAYLIST_TRACKS = 100;

// Use only explicit Spotify track/playlist URLs, stripping share-tracking parameters.
// Validating before passing a URL to DisTube also produces a clearer error for users.
function parseMusicQuery(input) {
  const value = String(input || "").trim();
  const spotifyUri = /^spotify:(track|playlist):([a-zA-Z0-9]{22})$/i.exec(value);
  if (spotifyUri) return {
    query: `https://open.spotify.com/${spotifyUri[1].toLowerCase()}/${spotifyUri[2]}`,
    kind: spotifyUri[1].toLowerCase()
  };
  if (!/^https?:\/\//i.test(value)) return { query: value, kind: "search" };
  let url;
  try { url = new URL(value); } catch { throw new Error("That music URL isn't valid."); }
  const host = url.hostname.toLowerCase();
  if (host === "open.spotify.com" || host === "play.spotify.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (/^intl-[a-z-]+$/i.test(segments[0] || "")) segments.shift();
    const [kind, id] = segments;
    if (!["track", "playlist"].includes(kind) || !/^[a-zA-Z0-9]{22}$/.test(id || "")) {
      throw new Error("Use a Spotify song or playlist link from Share → Copy link.");
    }
    return { query: `https://open.spotify.com/${kind}/${id}`, kind };
  }
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"].includes(host)) {
    return { query: value, kind: "youtube" };
  }
  throw new Error("Supported links: Spotify songs/playlists and YouTube videos/playlists.");
}

function markdownTitle(text) {
  return String(text || "Unknown song").replace(/([\\[\]()*_`~])/g, "\\$1").slice(0, 180);
}


export function createMusicManager(client) {
  let distube = null;
  let initialization = null;
  let startupError = null;
  const idleTimers = new Map();

  function redact(error) {
    let msg = String(error?.message || error || "Unknown error");
    for (const secret of [process.env.DISCORD_TOKEN, process.env.PROXY_URL,
      process.env.COOKIES_FILE, process.env.YOUTUBE_PO_TOKEN, process.env.YOUTUBE_API_KEY,
      process.env.SPOTIFY_CLIENT_SECRET]) {
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
      const { SpotifyPlugin } = require("@distube/spotify");
      const { YouTubePlugin } = require("./beatra_engine/src/music/plugins.js");
      const spotifyOptions = process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
        ? { api: { clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET } }
        : {};
      const instance = new DisTube(client, {
        // Original MusicBot plugin order: the playable YouTube extractor precedes Spotify.
        // Spotify resolves titles/playlist metadata; YouTube fetches actual audio.
        plugins: [new YouTubePlugin({ fallback: null }), new SpotifyPlugin(spotifyOptions)],
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
        // A request can be accepted before a playable audio stream exists.
        // Surface asynchronous playback errors to the channel, not only Railway logs.
        const textChannel = queue?.textChannel;
        if (textChannel?.send) {
          const trackName = markdownTitle(song?.name || 'Requested song');
          void textChannel.send({
            content: `❌ Unable to play **${trackName}**. ${redact(error).slice(0, 350)}`,
            allowedMentions: { parse: [] }
          }).catch(() => {});
        }
      });
      if (String(process.env.DEBUG || "").toLowerCase() === "true") {
        instance.on(Events.DEBUG, msg => console.log("[DisTube debug]", msg));
      }
      distube = instance;
      startupError = null;
      console.log(`[DisTube trial] Ready. Spotify links enabled; YouTube metadata search: ${process.env.YOUTUBE_API_KEY ? 'Data API v3' : 'yt-dlp search (may be blocked)'}; SoundCloud fallback OFF.`);
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
    const rawQuery = interaction.options.getString("query", true).trim();
    if (!rawQuery) return interaction.reply({ content: "Provide a song name, YouTube link, or Spotify track/playlist link.", ephemeral: true });
    let request;
    try { request = parseMusicQuery(rawQuery); }
    catch (error) { return interaction.reply({ content: `❌ ${redact(error)}`, ephemeral: true }); }

    await interaction.deferReply();
    try {
      const player = await init();
      const current = player.getQueue(interaction.guildId);
      if (current && current.voiceChannel?.id !== voice.id) {
        throw new Error("Music is already active in another voice channel. Use `/stop` there first.");
      }
      cancelIdle(interaction.guildId);
      const spotifyRequest = request.kind === "track" || request.kind === "playlist";
      console.log(`[DisTube trial] /play requested for guild ${interaction.guildId}: ${request.query.slice(0, 120)}`);
      const playOptions = {
        member,
        textChannel: interaction.channel,
        metadata: { guildId: interaction.guildId, requesterId: interaction.user.id }
      };

      // Resolve Spotify once so playlist name and song count are accurate, then
      // hand the resolved object directly to DisTube (as in the Beatra reference).
      // Preserve the proven direct YouTube path for non-Spotify queries.
      let resolved = null;
      let omitted = 0;
      if (spotifyRequest) {
        const { Playlist } = require("distube");
        resolved = await player.handler.resolve(request.query, playOptions);
        if (!resolved) throw new Error("Spotify couldn't find this song or playlist.");
        if (request.kind === "playlist") {
          if (!(resolved instanceof Playlist)) throw new Error("Spotify did not return a playable playlist.");
          omitted = Math.max(0, resolved.songs.length - MAX_SPOTIFY_PLAYLIST_TRACKS);
          if (omitted) resolved.songs = resolved.songs.slice(0, MAX_SPOTIFY_PLAYLIST_TRACKS);
          if (!resolved.songs.length) throw new Error("That Spotify playlist has no available songs.");
        }
        await player.play(voice, resolved, playOptions);
      } else {
        await player.play(voice, request.query, playOptions);
      }

      const queue = player.getQueue(interaction.guildId);
      const pending = queue?.songs?.at(-1);
      const isPlaylist = request.kind === "playlist";
      const spotifyUrl = spotifyRequest ? request.query : null;
      let description;
      if (isPlaylist) {
        const count = resolved.songs.length;
        description = `🎶 **Added Spotify playlist** [${markdownTitle(resolved.name || "Playlist")}](${spotifyUrl})\n` +
          `**${count} songs** added to the queue.` +
          (omitted ? `\nLimited to ${MAX_SPOTIFY_PLAYLIST_TRACKS} songs per request (${omitted} omitted).` : "");
      } else if (spotifyRequest) {
        const label = markdownTitle(resolved.name || "Spotify track");
        // play() may queue successfully before yt-dlp returns an audio stream.
        description = `${current ? "🎶 Queued" : "🎧 Loading audio for"} **[${label}](${spotifyUrl})**`;
      } else {
        description = pending?.url
          ? `${current ? "🎶 Queued" : "▶️ Started playing"} **[${markdownTitle(pending.name)}](${pending.url})**`
          : "🎶 Music request submitted";
      }
      const embed = new EmbedBuilder()
        .setColor(spotifyRequest ? 0x1db954 : 0x5865f2)
        .setDescription(description)
        .addFields({ name: "Audio", value: "YouTube via yt-dlp • SoundCloud fallback off" });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("[DisTube trial] /play error:", redact(error));
      const explanation = request.kind === "playlist"
        ? "If the playlist is large or private, it may need Spotify API credentials or a public playlist link."
        : "The music source may be unavailable; no SoundCloud preview was substituted.";
      await interaction.editReply(`❌ Couldn't play that link: ${redact(error)}\n${explanation}`);
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
