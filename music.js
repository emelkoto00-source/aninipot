import { Shoukaku, Connectors } from "shoukaku";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

// All connection settings come from Railway environment variables.
// Public Railway HTTPS/WSS domain: port=443, secure=true.
export function createMusicManager(client) {
  const host = (process.env.LAVALINK_HOST || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const port = Number(process.env.LAVALINK_PORT || "443");
  const auth = process.env.LAVALINK_PASSWORD || "";
  const secure = String(process.env.LAVALINK_SECURE || "true").toLowerCase() === "true";
  const configured = Boolean(host && auth && port > 0 && port <= 65535);

  const sessions = new Map();
  let shoukaku = null;
  let lastConnectionError = "Not connected to Lavalink yet";

  if (configured) {
    const node = {
      name: "railway-lavalink",
      url: `${host}:${port}`,
      auth,
      secure
    };

    shoukaku = new Shoukaku(
      new Connectors.DiscordJS(client),
      [node],
      {
        resume: true,
        reconnectTries: 5,
        reconnectInterval: 5,
        restTimeout: 15000
      }
    );

    shoukaku.on("ready", name => {
      lastConnectionError = "";
      console.log(`[Lavalink] Connected: ${name}`);
    });
    shoukaku.on("error", (name, error) => {
      lastConnectionError = error?.message || String(error);
      console.error(`[Lavalink] ${name} error:`, lastConnectionError);
    });
    shoukaku.on("close", (name, code, reason) => {
      lastConnectionError = `Disconnected (${code}): ${String(reason || "no reason")}`;
      console.warn(`[Lavalink] ${name}:`, lastConnectionError);
    });
    shoukaku.on("disconnect", (name, count) => {
      console.warn(`[Lavalink] ${name} disconnected. Reconnect attempt ${count}`);
    });
  }

  function logStatus() {
    if (!configured) {
      console.warn("[Lavalink] Missing/invalid Railway LAVALINK_HOST, PORT, PASSWORD or SECURE settings.");
    } else {
      console.log(`[Lavalink] Configured: ${host}:${port} (secure=${secure}). Waiting for ready event.`);
    }
  }

  function bestNode() {
    return shoukaku?.getIdealNode?.() || null;
  }

  function sanitizeError(error) {
    return String(error?.message || error || "Unknown error")
      .replaceAll("`", "'")
      .replaceAll(auth || "__no_secret_defined__", "[redacted]")
      .slice(0, 1200);
  }

  async function lookupSpotifyTrack(url) {
    // Spotify links supply metadata, not directly playable audio.
    const match = new URL(url);
    if (!/^\/track\//.test(match.pathname)) {
      throw new Error("Only Spotify track links are supported for now (not playlists or albums).");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Spotify track metadata returned HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.title) throw new Error("Spotify did not provide a track title.");
      return `${data.title} ${data.author_name || ""}`.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveTrack(node, userQuery) {
    let query = userQuery.trim();
    let isDirectUrl = false;
    if (/^https?:\/\//i.test(query)) {
      const u = new URL(query);
      const host = u.hostname.toLowerCase();
      if (host === "open.spotify.com" || host === "spotify.link") {
        if (host === "spotify.link") {
          // Explicitly require full track URLs to avoid following arbitrary redirects.
          throw new Error("Please paste a full open.spotify.com/track/... link instead of a shortened Spotify link.");
        }
        query = await lookupSpotifyTrack(query);
      } else if (host === "youtube.com" || host === "www.youtube.com" || host === "music.youtube.com" || host === "youtu.be") {
        isDirectUrl = true;
      } else {
        throw new Error("Use a song name, YouTube URL, or Spotify track URL.");
      }
    }

    const identifiers = isDirectUrl ? [query] : [`ytsearch:${query}`, `scsearch:${query}`];
    const failures = [];
    for (const id of identifiers) {
      try {
        const result = await node.rest.resolve(id);
        if (result?.loadType === "error") {
          failures.push(result.data?.message || `Source rejected ${id.split(':')[0]}`);
          continue;
        }
        let track;
        if (result?.loadType === "search" || result?.loadType === "playlist") {
          track = result.data?.tracks?.[0] || result.data?.[0];
        } else if (result?.loadType === "track") {
          track = result.data;
        }
        if (track?.encoded && track?.info) return track;
      } catch (error) {
        failures.push(sanitizeError(error));
      }
    }
    throw new Error(
      `No playable track found. ${failures.length ? failures.join("; ").slice(0, 600) : "Both YouTube and SoundCloud searches returned no results."}`
    );
  }

  function trackEmbed(track, title, user) {
    const info = track.info || {};
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(title)
      .setDescription(info.uri ? `[${String(info.title || "Unknown").slice(0, 160)}](${info.uri})` : String(info.title || "Unknown"))
      .addFields(
        { name: "Artist", value: String(info.author || "Unknown").slice(0, 100), inline: true },
        { name: "Length", value: info.length ? `${Math.floor(info.length / 60000)}:${String(Math.floor((info.length % 60000) / 1000)).padStart(2, "0")}` : "Unknown", inline: true }
      )
      .setFooter({ text: `Requested by ${user.username}` });
    if (info.artworkUrl) embed.setThumbnail(info.artworkUrl);
    return embed;
  }

  async function nextTrack(guildId) {
    const state = sessions.get(guildId);
    if (!state || state.switching || state.stopping) return;
    const next = state.queue.shift();
    if (!next) {
      state.current = null;
      return;
    }
    state.switching = true;
    state.current = next;
    try {
      await state.player.playTrack({ track: { encoded: next.encoded } });
      console.log(`[Lavalink] Play request accepted: ${next.info?.title || "unknown"}`);
    } catch (error) {
      console.error("[Lavalink] playTrack failed:", sanitizeError(error));
      state.current = null;
      state.switching = false;
      await nextTrack(guildId);
      return;
    }
    state.switching = false;
  }

  function attachPlayerEvents(state) {
    const player = state.player;
    player.on("start", () => {
      console.log(`[Lavalink] Track started in ${state.guildId}: ${state.current?.info?.title || "unknown"}`);
    });
    player.on("end", event => {
      console.log(`[Lavalink] Track ended in ${state.guildId}: ${event?.reason || "unknown"}`);
      if (state.stopping || event?.reason === "replaced") return;
      state.current = null;
      void nextTrack(state.guildId);
    });
    player.on("exception", event => {
      console.error(`[Lavalink] Track exception in ${state.guildId}:`, event?.exception?.message || event);
    });
    player.on("stuck", event => {
      console.error(`[Lavalink] Track stuck in ${state.guildId}:`, event?.thresholdMs || event);
    });
    player.on("closed", (data) => {
      console.warn(`[Lavalink] Voice connection closed in ${state.guildId}:`, data);
    });
  }

  async function play(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Use `/play` inside a server.", ephemeral: true });
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const voice = member?.voice?.channel;
    if (!voice) {
      await interaction.reply({ content: "🎧 Join a voice channel first.", ephemeral: true });
      return;
    }
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const permissions = me && voice.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
      await interaction.reply({ content: "I need **Connect** and **Speak** permissions in your voice channel.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const node = bestNode();
      if (!node) {
        throw new Error(`Lavalink is not connected yet. ${lastConnectionError || "Check the Lavalink server logs."}`);
      }
      const query = interaction.options.getString("query", true);
      const track = await resolveTrack(node, query);
      let state = sessions.get(interaction.guildId);
      if (state && state.channelId !== voice.id) {
        throw new Error("Music is already active in another voice channel. Use `/stop` there first.");
      }
      if (!state) {
        const player = await shoukaku.joinVoiceChannel({
          guildId: interaction.guildId,
          channelId: voice.id,
          shardId: interaction.guild.shardId,
          deaf: true
        });
        state = {
          guildId: interaction.guildId,
          channelId: voice.id,
          player,
          queue: [],
          current: null,
          switching: false,
          stopping: false
        };
        sessions.set(interaction.guildId, state);
        attachPlayerEvents(state);
      }
      const queued = Boolean(state.current || state.switching || state.queue.length);
      state.queue.push(track);
      if (!queued) await nextTrack(state.guildId);
      await interaction.editReply({
        embeds: [trackEmbed(track, queued ? "🎵 Added to Queue" : "🎶 Sent to Lavalink", interaction.user)]
      });
    } catch (error) {
      console.error("[Lavalink] /play:", sanitizeError(error));
      await interaction.editReply(`❌ Music error: ${sanitizeError(error)}`);
    }
  }

  async function stop(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "Use `/stop` inside a server.", ephemeral: true });
      return;
    }
    const state = sessions.get(interaction.guildId);
    if (!state) {
      await interaction.reply({ content: "There's no active music session here.", ephemeral: true });
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const allowed = member?.voice?.channelId === state.channelId ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!allowed) {
      await interaction.reply({ content: "Join the bot's voice channel to stop it (or use **Manage Server** permission).", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    state.stopping = true;
    state.queue.length = 0;
    sessions.delete(interaction.guildId);
    try {
      await shoukaku.leaveVoiceChannel(interaction.guildId);
      await interaction.editReply("⏹️ Stopped the music and left the voice channel.");
    } catch (error) {
      await interaction.editReply(`❌ Could not disconnect: ${sanitizeError(error)}`);
    }
  }

  return { logStatus, play, stop };
}
