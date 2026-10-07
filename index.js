import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits
} from "discord.js";
import { commandsJSON } from "./commands.js";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
  entersState,
  getVoiceConnection
} from "@discordjs/voice";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
  console.log(`FFmpeg configured: ${ffmpegPath}`);
} else {
  console.warn("ffmpeg-static did not provide an FFmpeg path.");
}

const musicSessions = new Map();

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      host === "youtu.be" ||
      host.endsWith("youtube.com") ||
      host.endsWith("music.youtube.com")
    );
  } catch {
    return false;
  }
}

function isSpotifyUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase().endsWith("spotify.com");
  } catch {
    return false;
  }
}

async function loadYtdl() {
  const mod = await import("@distube/ytdl-core");
  return mod.default ?? mod;
}

async function loadYtSearch() {
  const mod = await import("yt-search");
  return mod.default ?? mod;
}

async function spotifyLinkToSearchQuery(url) {
  const endpoint =
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;

  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Spotify metadata request failed with HTTP ${response.status}.`
    );
  }

  const data = await response.json();

  if (!data?.title) {
    throw new Error("Spotify did not return a track title for that link.");
  }

  return `${data.title} official audio`;
}

async function resolveMusicQuery(query) {
  const ytdl = await loadYtdl();

  if (isYouTubeUrl(query)) {
    const info = await ytdl.getInfo(query);
    const details = info.videoDetails;

    return {
      title: details.title || "YouTube Track",
      author: details.author?.name || details.ownerChannelName || "YouTube",
      duration: details.lengthSeconds
        ? formatDuration(Number(details.lengthSeconds) * 1000)
        : "Unknown",
      url: details.video_url || query,
      thumbnail:
        details.thumbnails?.at(-1)?.url ||
        details.thumbnails?.[0]?.url ||
        null
    };
  }

  let searchQuery = query;

  if (isSpotifyUrl(query)) {
    searchQuery = await spotifyLinkToSearchQuery(query);
  }

  const ytSearch = await loadYtSearch();
  const results = await ytSearch(searchQuery);
  const video = results?.videos?.[0];

  if (!video?.url) {
    throw new Error(
      "No matching YouTube result was found for that request."
    );
  }

  return {
    title: video.title || "YouTube Track",
    author: video.author?.name || "YouTube",
    duration: video.timestamp || "Unknown",
    url: video.url,
    thumbnail: video.thumbnail || null
  };
}

function cleanupCurrentAudio(session) {
  try {
    session.sourceStream?.destroy?.();
  } catch {}

  try {
    session.ffmpeg?.stdin?.destroy?.();
  } catch {}

  try {
    session.ffmpeg?.kill?.("SIGKILL");
  } catch {}

  session.sourceStream = null;
  session.ffmpeg = null;
}

async function ensureVoiceConnection(voiceChannel, session) {
  let connection = getVoiceConnection(voiceChannel.guild.id);

  if (
    connection &&
    connection.joinConfig.channelId !== voiceChannel.id
  ) {
    try {
      connection.destroy();
    } catch {}

    connection = null;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
  }

  session.connection = connection;

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      30000
    );
  } catch (error) {
    const status =
      connection?.state?.status ||
      "unknown";

    throw new Error(
      `Discord voice connection never became Ready. Current status: ${status}.`
    );
  }

  const subscription = connection.subscribe(session.audioPlayer);

  if (!subscription) {
    throw new Error(
      "The voice connection could not subscribe to the audio player."
    );
  }

  return connection;
}

async function streamTrack(session, track) {
  cleanupCurrentAudio(session);

  const ytdl = await loadYtdl();

  const sourceStream = ytdl(track.url, {
    filter: format =>
      format.hasAudio &&
      !format.hasVideo &&
      (
        format.codecs?.includes("opus") ||
        format.mimeType?.includes("webm") ||
        format.mimeType?.includes("ogg")
      ),
    quality: "highestaudio",
    highWaterMark: 1 << 25
  });

  session.sourceStream = sourceStream;

  let streamError = null;

  sourceStream.once("error", error => {
    streamError = error;
    console.error(
      "YouTube source stream error:",
      error?.message || error
    );
  });

  // Discord can play Opus/WebM/Ogg audio directly. Probe the stream so
  // @discordjs/voice knows the correct input type and no FFmpeg
  // transcoding is required.
  let probed;

  try {
    probed = await Promise.race([
      demuxProbe(sourceStream),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(
            new Error(
              "Timed out while waiting for YouTube audio data."
            )
          ),
          15000
        )
      )
    ]);
  } catch (error) {
    try {
      sourceStream.destroy();
    } catch {}

    throw new Error(
      streamError?.message ||
      error?.message ||
      "Could not probe the YouTube audio stream."
    );
  }

  if (!probed?.stream || !probed?.type) {
    throw new Error(
      "YouTube returned a stream, but its audio format could not be detected."
    );
  }

  const resource = createAudioResource(probed.stream, {
    inputType: probed.type,
    metadata: track
  });

  session.audioPlayer.play(resource);

  try {
    await entersState(
      session.audioPlayer,
      AudioPlayerStatus.Playing,
      20000
    );
  } catch {
    const playerStatus =
      session.audioPlayer?.state?.status ||
      "unknown";

    throw new Error(
      `Audio player never reached Playing. ` +
      `Player status: ${playerStatus}. ` +
      `The YouTube stream was detected as ${String(probed.type)}.`
    );
  }
}

async function sendNowPlaying(session, track) {
  if (!track.textChannelId) return;

  try {
    const channel = await client.channels.fetch(track.textChannelId);

    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle("🎶 Now Playing")
      .setDescription(`[${track.title}](${track.url})`)
      .addFields(
        {
          name: "Artist / Uploader",
          value: track.author || "Unknown",
          inline: true
        },
        {
          name: "Duration",
          value: track.duration || "Unknown",
          inline: true
        }
      )
      .setThumbnail(track.thumbnail || null);

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error(
      "Could not send Now Playing message:",
      error?.message || error
    );
  }
}

async function playNextInSession(session) {
  if (session.starting) return;

  const next = session.queue.shift();

  if (!next) {
    session.current = null;
    cleanupCurrentAudio(session);
    return;
  }

  session.starting = true;
  session.current = next;

  try {
    await streamTrack(session, next);
    console.log(`Playback started: ${next.title}`);

    // For queued songs after the first one.
    if (!next.suppressAutoAnnouncement) {
      await sendNowPlaying(session, next);
    }
  } catch (error) {
    console.error(
      `Track playback failed (${next.title}):`,
      error?.message || error
    );

    if (next.textChannelId) {
      try {
        const channel = await client.channels.fetch(next.textChannelId);

        if (channel?.isTextBased()) {
          await channel.send(
            `❌ Could not play **${next.title}**: \`${String(
              error?.message || error
            ).replace(/`/g, "'").slice(0, 1000)}\``
          );
        }
      } catch {}
    }

    session.current = null;

    setTimeout(() => {
      playNextInSession(session).catch(console.error);
    }, 500);
  } finally {
    session.starting = false;
  }
}

function getOrCreateMusicSession(guildId) {
  let session = musicSessions.get(guildId);

  if (session) return session;

  const audioPlayer = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  });

  session = {
    guildId,
    audioPlayer,
    connection: null,
    queue: [],
    current: null,
    starting: false,
    sourceStream: null,
    ffmpeg: null
  };

  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    cleanupCurrentAudio(session);
    session.current = null;

    setTimeout(() => {
      playNextInSession(session).catch(console.error);
    }, 250);
  });

  audioPlayer.on("error", error => {
    console.error(
      "Direct audio player error:",
      error?.message || error
    );

    cleanupCurrentAudio(session);
    session.current = null;

    setTimeout(() => {
      playNextInSession(session).catch(console.error);
    }, 500);
  });

  musicSessions.set(guildId, session);
  return session;
}

const jokes = [
  "Why did the computer go to therapy? It had too many unresolved issues.",
  "Why do programmers prefer dark mode? Because light attracts bugs.",
  "I told my Wi-Fi we needed space. Now we're disconnected.",
  "Why was the JavaScript developer sad? Because they didn't Node how to Express themselves.",
  "My Discord bot applied for a job. It said it had excellent server experience.",
  "Why did the scarecrow win an award? Because he was outstanding in his field.",
  "What do you call fake spaghetti? An impasta.",
  "Why couldn't the bicycle stand up by itself? It was two-tired."
];

const quotes = [
  "Small progress is still progress.",
  "Make it simple, but make it work.",
  "Consistency beats intensity when intensity doesn't last.",
  "The best way to learn is to build something.",
  "You don't need perfect conditions to start.",
  "Focus on the next useful step.",
  "Good systems make hard things easier.",
  "Build, test, improve, repeat."
];

const eightBallAnswers = [
  "It is certain.",
  "Without a doubt.",
  "Yes — definitely.",
  "Most likely.",
  "Signs point to yes.",
  "Ask again later.",
  "Cannot predict now.",
  "Better not tell you now.",
  "Don't count on it.",
  "My reply is no.",
  "Very doubtful."
];

const stickies = new Map();
const stickyTimers = new Map();

async function sendStickyMessage(channel, sticky) {
  let description = sticky.message;

  if (sticky.linkUrl) {
    const safeLabel = sticky.linkText || "here";
    const afterLink = sticky.afterLink || "";
    description += `
click [${safeLabel}](${sticky.linkUrl})${afterLink ? ` ${afterLink}` : ""}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x4f545c)
    .setDescription(description);

  return channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] }
  });
}

async function deleteStickyMessage(channel, messageId) {
  if (!messageId) return;

  try {
    await channel.messages.delete(messageId);
  } catch {
    // The previous sticky may already have been deleted manually.
  }
}

function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function parseDuration(input) {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim());
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  };

  const ms = amount * multipliers[unit];
  const max = 28 * 24 * 60 * 60 * 1000;

  if (ms < 1000 || ms > max) return null;
  return ms;
}

async function registerCommands() {
  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commandsJSON);
      console.log(`Registered ${commandsJSON.length} slash commands in ${guild.name}.`);
    } else {
      await client.application.commands.set(commandsJSON);
      console.log(`Registered ${commandsJSON.length} global slash commands.`);
      console.log("Tip: set GUILD_ID during testing for faster command updates.");
    }
  } catch (error) {
    console.error("Could not register slash commands:", error);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Serving ${client.guilds.cache.size} server(s).`);
  await registerCommands();
  console.log("Direct Discord voice music engine ready (native Opus/WebM streaming).");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "ping": {
        const sent = await interaction.reply({
          content: "Pinging...",
          fetchReply: true
        });

        const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(
          `🏓 Pong! Round-trip: **${roundTrip}ms** | WebSocket: **${client.ws.ping}ms**`
        );
        break;
      }

      case "hello": {
        await interaction.reply(`👋 Hello, ${interaction.user}!`);
        break;
      }

      case "userinfo": {
        const user = interaction.options.getUser("user") || interaction.user;
        const member = interaction.guild
          ? await interaction.guild.members.fetch(user.id).catch(() => null)
          : null;

        const embed = new EmbedBuilder()
          .setTitle(`User Info — ${user.username}`)
          .setThumbnail(user.displayAvatarURL({ size: 512 }))
          .addFields(
            { name: "Username", value: user.tag || user.username, inline: true },
            { name: "User ID", value: user.id, inline: true },
            {
              name: "Account Created",
              value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
              inline: false
            },
            {
              name: "Joined Server",
              value: member?.joinedTimestamp
                ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
                : "Not available",
              inline: false
            }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "serverinfo": {
        if (!interaction.guild) {
          await interaction.reply({
            content: "This command can only be used in a server.",
            ephemeral: true
          });
          break;
        }

        const guild = interaction.guild;
        const owner = await guild.fetchOwner().catch(() => null);

        const embed = new EmbedBuilder()
          .setTitle(`Server Info — ${guild.name}`)
          .setThumbnail(guild.iconURL({ size: 512 }) || null)
          .addFields(
            { name: "Server ID", value: guild.id, inline: true },
            { name: "Owner", value: owner ? `${owner.user}` : "Unavailable", inline: true },
            { name: "Members", value: String(guild.memberCount), inline: true },
            {
              name: "Created",
              value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`,
              inline: false
            }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "avatar": {
        const user = interaction.options.getUser("user") || interaction.user;
        const avatar = user.displayAvatarURL({ size: 1024 });

        const embed = new EmbedBuilder()
          .setTitle(`${user.username}'s Avatar`)
          .setImage(avatar);

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "say": {
        const message = interaction.options.getString("message", true);

        await interaction.reply({
          content: "✅ Sent.",
          ephemeral: true
        });

        await interaction.channel.send({
          content: message,
          allowedMentions: { parse: [] }
        });
        break;
      }

      case "embed": {
        const title = interaction.options.getString("title", true);
        const message = interaction.options.getString("message", true);

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(message)
          .setFooter({ text: `Requested by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "coinflip": {
        await interaction.reply(`🪙 **${Math.random() < 0.5 ? "Heads" : "Tails"}!**`);
        break;
      }

      case "roll": {
        const sides = interaction.options.getInteger("sides") || 6;
        const result = Math.floor(Math.random() * sides) + 1;
        await interaction.reply(`🎲 You rolled **${result}** out of **${sides}**.`);
        break;
      }

      case "8ball": {
        const question = interaction.options.getString("question", true);
        const answer = randomItem(eightBallAnswers);

        const embed = new EmbedBuilder()
          .setTitle("🎱 Magic 8-Ball")
          .addFields(
            { name: "Question", value: question },
            { name: "Answer", value: `**${answer}**` }
          );

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "random": {
        const min = interaction.options.getInteger("min", true);
        const max = interaction.options.getInteger("max", true);

        if (min > max) {
          await interaction.reply({
            content: "The minimum number must be less than or equal to the maximum.",
            ephemeral: true
          });
          break;
        }

        const result = Math.floor(Math.random() * (max - min + 1)) + min;
        await interaction.reply(`🔢 Random number: **${result}**`);
        break;
      }

      case "choose": {
        const raw = interaction.options.getString("options", true);
        const options = raw
          .split(",")
          .map(item => item.trim())
          .filter(Boolean);

        if (options.length < 2) {
          await interaction.reply({
            content: "Give me at least two options separated by commas.",
            ephemeral: true
          });
          break;
        }

        await interaction.reply(`🤔 I choose: **${randomItem(options)}**`);
        break;
      }

      case "joke": {
        await interaction.reply(`😂 ${randomItem(jokes)}`);
        break;
      }

      case "quote": {
        await interaction.reply(`💬 *"${randomItem(quotes)}"*`);
        break;
      }

      case "uptime": {
        await interaction.reply(`⏱️ Uptime: **${formatDuration(client.uptime || 0)}**`);
        break;
      }

      case "botinfo": {
        const embed = new EmbedBuilder()
          .setTitle(`Bot Info — ${client.user.username}`)
          .setThumbnail(client.user.displayAvatarURL({ size: 512 }))
          .addFields(
            { name: "Version", value: "1.0.0", inline: true },
            { name: "WebSocket Ping", value: `${client.ws.ping}ms`, inline: true },
            { name: "Servers", value: String(client.guilds.cache.size), inline: true },
            { name: "Uptime", value: formatDuration(client.uptime || 0), inline: true }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "help": {
        const helpText = [
          "`/ping` — Check bot latency",
          "`/hello` — Get a greeting",
          "`/userinfo [user]` — Show user information",
          "`/serverinfo` — Show server information",
          "`/avatar [user]` — Show a user's avatar",
          "`/say <message>` — Make the bot repeat a message",
          "`/embed <title> <message>` — Send an embed",
          "`/coinflip` — Flip a coin",
          "`/roll [sides]` — Roll a die",
          "`/8ball <question>` — Ask the Magic 8-Ball",
          "`/random <min> <max>` — Random whole number",
          "`/choose <options>` — Pick from comma-separated options",
          "`/joke` — Random joke",
          "`/quote` — Random quote",
          "`/uptime` — Show bot uptime",
          "`/botinfo` — Show bot information",
          "`/help` — Show this list",
          "`/play <query>` — Play or queue a song, YouTube link, or Spotify link",
          "`/sticky <message>` — Moderator: keep a message at the bottom of the channel",
          "`/unsticky` — Moderator: remove the channel sticky",
          "`/clear <amount>` — Moderator: delete recent messages",
          "`/kick <user> [reason]` — Moderator: kick a member",
          "`/ban <user> [reason]` — Moderator: ban a member",
          "`/timeout <user> <duration> [reason]` — Moderator: timeout a member"
        ].join("\n");

        const embed = new EmbedBuilder()
          .setTitle("📖 Bot Commands")
          .setDescription(helpText)
          .setFooter({ text: "Timeout examples: 10m, 2h, 1d" });

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "play": {
        if (!interaction.guild) {
          await interaction.reply({
            content: "This command can only be used in a server.",
            ephemeral: true
          });
          break;
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);

        const voiceChannel = member?.voice?.channel;

        if (!voiceChannel) {
          await interaction.reply({
            content: "🎧 Join a voice channel first, then use `/play`.",
            ephemeral: true
          });
          break;
        }

        const botMember =
          interaction.guild.members.me ||
          await interaction.guild.members.fetchMe().catch(() => null);

        const voicePermissions = botMember
          ? voiceChannel.permissionsFor(botMember)
          : null;

        if (
          !voicePermissions?.has(PermissionFlagsBits.Connect) ||
          !voicePermissions?.has(PermissionFlagsBits.Speak)
        ) {
          await interaction.reply({
            content:
              "❌ I need **Connect** and **Speak** permission in your voice channel.",
            ephemeral: true
          });
          break;
        }

        const query =
          interaction.options.getString("query", true).trim();

        await interaction.deferReply();

        try {
          const track = await resolveMusicQuery(query);

          track.requestedBy = interaction.user.id;
          track.requestedByName = interaction.user.username;
          track.textChannelId = interaction.channelId;

          const session = getOrCreateMusicSession(
            interaction.guild.id
          );

          await ensureVoiceConnection(voiceChannel, session);

          const alreadyBusy =
            session.current ||
            session.starting ||
            session.audioPlayer.state.status === AudioPlayerStatus.Playing ||
            session.audioPlayer.state.status === AudioPlayerStatus.Paused;

          if (alreadyBusy) {
            session.queue.push(track);

            const embed = new EmbedBuilder()
              .setTitle("🎵 Added to Queue")
              .setDescription(`[${track.title}](${track.url})`)
              .addFields(
                {
                  name: "Artist / Uploader",
                  value: track.author || "Unknown",
                  inline: true
                },
                {
                  name: "Duration",
                  value: track.duration || "Unknown",
                  inline: true
                },
                {
                  name: "Queue Position",
                  value: String(session.queue.length),
                  inline: true
                }
              )
              .setThumbnail(track.thumbnail || null)
              .setFooter({
                text: `Requested by ${interaction.user.username}`
              });

            await interaction.editReply({ embeds: [embed] });
            break;
          }

          track.suppressAutoAnnouncement = true;
          session.queue.push(track);

          await playNextInSession(session);

          if (
            session.audioPlayer.state.status !== AudioPlayerStatus.Playing
          ) {
            throw new Error(
              `Playback setup finished but the audio player is ` +
              `${session.audioPlayer.state.status}.`
            );
          }

          const embed = new EmbedBuilder()
            .setTitle("🎶 Now Playing")
            .setDescription(`[${track.title}](${track.url})`)
            .addFields(
              {
                name: "Artist / Uploader",
                value: track.author || "Unknown",
                inline: true
              },
              {
                name: "Duration",
                value: track.duration || "Unknown",
                inline: true
              }
            )
            .setThumbnail(track.thumbnail || null)
            .setFooter({
              text: `Requested by ${interaction.user.username}`
            });

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          console.error("Direct /play error:", error);

          const safeMessage = String(
            error?.message ||
            error?.cause?.message ||
            error ||
            "Unknown music error"
          )
            .replace(/`/g, "'")
            .slice(0, 1500);

          await interaction.editReply(
            `❌ I couldn't start playback.\n\n**Music error:** \`${safeMessage}\``
          );
        }

        break;
      }

      case "sticky": {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.editReply(
            "You need the **Manage Messages** permission to use this command."
          );
          break;
        }

        const channel = interaction.channel;
        const message = interaction.options.getString("message", true).trim();
        const linkUrl = interaction.options.getString("link_url")?.trim() || "";
        const linkText = interaction.options.getString("link_text")?.trim() || "here";
        const afterLink = interaction.options.getString("after_link")?.trim() || "";

        if (!channel?.isTextBased() || !("send" in channel)) {
          await interaction.editReply(
            "Sticky messages can only be used in a normal text-based channel."
          );
          break;
        }

        if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
          await interaction.editReply(
            "The `link_url` must start with `https://` or `http://`."
          );
          break;
        }

        const botMember = interaction.guild?.members.me;
        const botPermissions = botMember
          ? channel.permissionsFor(botMember)
          : null;

        if (
          !botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
          !botPermissions?.has(PermissionFlagsBits.SendMessages)
        ) {
          await interaction.editReply(
            "❌ I can't create the sticky here. Give my bot role **View Channel** and **Send Messages** permission in this channel."
          );
          break;
        }

        const existing = stickies.get(channel.id);

        if (existing?.messageId) {
          await deleteStickyMessage(channel, existing.messageId);
        }

        const stickyData = {
          message,
          linkUrl,
          linkText,
          afterLink
        };

        try {
          const stickyMessage = await sendStickyMessage(channel, stickyData);

          stickies.set(channel.id, {
            ...stickyData,
            messageId: stickyMessage.id
          });

          await interaction.editReply(
            "📌 Compact sticky embed enabled for this channel."
          );
        } catch (error) {
          console.error("Sticky send error:", error);

          await interaction.editReply(
            "❌ I couldn't send the sticky embed. Check my bot permissions in this channel."
          );
        }

        break;
      }

      case "unsticky": {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.editReply(
            "You need the **Manage Messages** permission to use this command."
          );
          break;
        }

        const channel = interaction.channel;
        const existing = stickies.get(channel.id);

        if (!existing) {
          await interaction.editReply(
            "There is no active sticky message in this channel."
          );
          break;
        }

        const timer = stickyTimers.get(channel.id);
        if (timer) {
          clearTimeout(timer);
          stickyTimers.delete(channel.id);
        }

        await deleteStickyMessage(channel, existing.messageId);
        stickies.delete(channel.id);

        await interaction.editReply(
          "✅ Sticky message removed from this channel."
        );
        break;
      }

      case "clear": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.reply({
            content: "You need the **Manage Messages** permission to use this command.",
            ephemeral: true
          });
          break;
        }

        const amount = interaction.options.getInteger("amount", true);

        if (!interaction.channel?.isTextBased() || !("bulkDelete" in interaction.channel)) {
          await interaction.reply({
            content: "This channel does not support bulk message deletion.",
            ephemeral: true
          });
          break;
        }

        const deleted = await interaction.channel.bulkDelete(amount, true);

        await interaction.reply({
          content: `🧹 Deleted **${deleted.size}** message(s). Messages older than 14 days cannot be bulk deleted.`,
          ephemeral: true
        });
        break;
      }

      case "kick": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)) {
          await interaction.reply({
            content: "You need the **Kick Members** permission.",
            ephemeral: true
          });
          break;
        }

        const user = interaction.options.getUser("user", true);
        const reason = interaction.options.getString("reason") || "No reason provided.";
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!member) {
          await interaction.reply({
            content: "That user is not currently in this server.",
            ephemeral: true
          });
          break;
        }

        if (!member.kickable) {
          await interaction.reply({
            content: "I cannot kick that member. Check my role position and permissions.",
            ephemeral: true
          });
          break;
        }

        await member.kick(`${reason} | By ${interaction.user.tag}`);
        await interaction.reply(`👢 Kicked **${user.tag}**. Reason: ${reason}`);
        break;
      }

      case "ban": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
          await interaction.reply({
            content: "You need the **Ban Members** permission.",
            ephemeral: true
          });
          break;
        }

        const user = interaction.options.getUser("user", true);
        const reason = interaction.options.getString("reason") || "No reason provided.";

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (member && !member.bannable) {
          await interaction.reply({
            content: "I cannot ban that member. Check my role position and permissions.",
            ephemeral: true
          });
          break;
        }

        await interaction.guild.members.ban(user.id, {
          reason: `${reason} | By ${interaction.user.tag}`
        });

        await interaction.reply(`🔨 Banned **${user.tag}**. Reason: ${reason}`);
        break;
      }

      case "timeout": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
          await interaction.reply({
            content: "You need the **Moderate Members** permission.",
            ephemeral: true
          });
          break;
        }

        const user = interaction.options.getUser("user", true);
        const durationText = interaction.options.getString("duration", true);
        const reason = interaction.options.getString("reason") || "No reason provided.";
        const durationMs = parseDuration(durationText);

        if (!durationMs) {
          await interaction.reply({
            content: "Invalid duration. Use formats like `30s`, `10m`, `2h`, or `1d`. Maximum is 28 days.",
            ephemeral: true
          });
          break;
        }

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!member) {
          await interaction.reply({
            content: "That user is not currently in this server.",
            ephemeral: true
          });
          break;
        }

        if (!member.moderatable) {
          await interaction.reply({
            content: "I cannot timeout that member. Check my role position and permissions.",
            ephemeral: true
          });
          break;
        }

        await member.timeout(durationMs, `${reason} | By ${interaction.user.tag}`);
        await interaction.reply(
          `⏳ Timed out **${user.tag}** for **${durationText}**. Reason: ${reason}`
        );
        break;
      }
    }
  } catch (error) {
    console.error(`Command error (${interaction.commandName}):`, error);

    const message = {
      content: "Something went wrong while running that command.",
      ephemeral: true
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
});

client.on("messageCreate", message => {
  if (message.author.bot) return;

  const sticky = stickies.get(message.channelId);
  if (!sticky) return;

  const existingTimer = stickyTimers.get(message.channelId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(async () => {
    stickyTimers.delete(message.channelId);

    const currentSticky = stickies.get(message.channelId);
    if (!currentSticky) return;

    try {
      await deleteStickyMessage(message.channel, currentSticky.messageId);

      const newSticky = await sendStickyMessage(
        message.channel,
        currentSticky
      );

      stickies.set(message.channelId, {
        ...currentSticky,
        messageId: newSticky.id
      });
    } catch (error) {
      console.error(`Sticky message error in ${message.channelId}:`, error);
    }
  }, 1200);

  stickyTimers.set(message.channelId, timer);
});

client.on("error", console.error);

process.on("unhandledRejection", error => {
  console.error("Unhandled promise rejection:", error);
});

client.login(TOKEN);
