import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits
} from "discord.js";
import { commandsJSON } from "./commands.js";
import { Player } from "discord-player";

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

const player = new Player(client);

let musicReady = false;
let musicInitError = "Music system has not initialized yet.";

// Prevent Discord Player queue errors from becoming unhandled process errors.
player.events.on("error", (queue, error) => {
  console.error(
    "Discord Player queue error:",
    error?.message || String(error)
  );
});

player.events.on("playerError", (queue, error) => {
  console.error(
    "Discord Player playback error:",
    error?.message || String(error)
  );
});

// ExtractorExecutionContext is also an EventEmitter.
// If it emits "error" without a listener, Node can terminate the process.
if (typeof player.extractors?.on === "function") {
  player.extractors.on("error", (...args) => {
    const actualError =
      args.find(value => value instanceof Error) ??
      args.find(value => value?.message) ??
      args.at(-1);

    console.error(
      "Music extractor error:",
      actualError?.message || String(actualError || "Unknown extractor error")
    );
  });
}

async function initializeMusic() {
  try {
    const extractorModule = await import("@discord-player/extractor");
    const extractorPackage = extractorModule.default ?? extractorModule;

    let defaults =
      extractorModule.DefaultExtractors ??
      extractorPackage.DefaultExtractors;

    if (!Array.isArray(defaults)) {
      defaults = Object.entries({
        ...extractorPackage,
        ...extractorModule
      })
        .filter(([name, value]) =>
          name.endsWith("Extractor") &&
          typeof value === "function"
        )
        .map(([, value]) => value);
    }

    const youtubeiModule = await import("discord-player-youtubei");

    function findYouTubeExtractor(root) {
      const seen = new Set();

      function walk(value, keyName = "", depth = 0) {
        if (value == null || depth > 4) return null;

        if (typeof value === "function") {
          const combinedName = `${keyName} ${value.name || ""}`;

          if (/youtube.*extractor|extractor.*youtube|youtubei/i.test(combinedName)) {
            return value;
          }

          return null;
        }

        if (typeof value !== "object") return null;
        if (seen.has(value)) return null;
        seen.add(value);

        for (const [key, child] of Object.entries(value)) {
          const found = walk(child, key, depth + 1);
          if (found) return found;
        }

        return null;
      }

      return walk(root);
    }

    const YoutubeiExtractor =
      youtubeiModule.YoutubeiExtractor ??
      youtubeiModule.YouTubeiExtractor ??
      youtubeiModule.YoutubeExtractor ??
      youtubeiModule.YouTubeExtractor ??
      youtubeiModule.default?.YoutubeiExtractor ??
      youtubeiModule.default?.YouTubeiExtractor ??
      youtubeiModule.default?.YoutubeExtractor ??
      youtubeiModule.default?.YouTubeExtractor ??
      findYouTubeExtractor(youtubeiModule);

    const registry = player.extractors;

    if (typeof registry.register !== "function") {
      throw new Error(
        `extractors.register() is unavailable. Methods: ${
          Object.getOwnPropertyNames(Object.getPrototypeOf(registry)).join(", ")
        }`
      );
    }

    let registered = 0;
    let failed = 0;

    for (const Extractor of defaults || []) {
      // Do not register the dedicated youtubei extractor through this list.
      if (
        !Extractor ||
        typeof Extractor !== "function" ||
        /youtubei/i.test(Extractor.name || "")
      ) {
        continue;
      }

      try {
        await registry.register(Extractor, {});
        registered++;
      } catch (error) {
        const message = String(error?.message || error);

        if (/already|duplicate|registered/i.test(message)) {
          continue;
        }

        failed++;
        console.error(
          `Default extractor ${Extractor?.name || "unknown"} failed:`,
          message
        );
      }
    }

    if (typeof YoutubeiExtractor !== "function") {
      const topLevelKeys = Object.keys(youtubeiModule).join(", ") || "(none)";
      const defaultKeys =
        youtubeiModule.default && typeof youtubeiModule.default === "object"
          ? Object.keys(youtubeiModule.default).join(", ")
          : "(default is not an object)";

      throw new Error(
        `Could not locate the YouTube extractor export. ` +
        `Top-level exports: ${topLevelKeys}. ` +
        `Default exports: ${defaultKeys}.`
      );
    }

    console.log(
      `YouTube extractor discovered: ${YoutubeiExtractor.name || "anonymous extractor"}`
    );

    try {
      await registry.register(YoutubeiExtractor, {});
      registered++;
    } catch (error) {
      const message = String(error?.message || error);

      if (!/already|duplicate|registered/i.test(message)) {
        throw new Error(`YouTube extractor failed: ${message}`);
      }
    }

    musicReady = true;
    musicInitError = "";

    console.log(
      `Music system ready. Extractors registered: ${registered}; optional failures: ${failed}.`
    );
  } catch (error) {
    musicReady = false;
    musicInitError = String(
      error?.message ||
      error?.cause?.message ||
      error ||
      "Unknown music initialization error"
    ).slice(0, 1000);

    // IMPORTANT: do not throw here. Keep the Discord bot online.
    console.error("Music initialization failed:", musicInitError);
  }
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

  // Music initialization is isolated so an extractor problem cannot crash bebot.
  await initializeMusic();
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

        if (!musicReady) {
          await interaction.reply({
            content: `🎵 The music system is currently unavailable.\n\n**Music error:** \`${musicInitError.replace(/`/g, "'").slice(0, 1000)}\``,
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
            content: "❌ I need **Connect** and **Speak** permission in your voice channel.",
            ephemeral: true
          });
          break;
        }

        const query = interaction.options.getString("query", true).trim();

        await interaction.deferReply();

        try {
          const { track } = await player.play(voiceChannel, query, {
            nodeOptions: {
              metadata: {
                textChannelId: interaction.channelId,
                requestedBy: interaction.user.id
              },
              volume: 70,
              selfDeaf: true,
              leaveOnEmpty: true,
              leaveOnEmptyCooldown: 300000,
              leaveOnEnd: true,
              leaveOnEndCooldown: 120000
            }
          });

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
              }
            )
            .setThumbnail(track.thumbnail || null)
            .setFooter({
              text: `Requested by ${interaction.user.username}`
            });

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          console.error("Play command error:", error);

          const rawMessage = String(
            error?.message ||
            error?.cause?.message ||
            error ||
            "Unknown playback error"
          );

          const safeMessage = rawMessage
            .replace(/`/g, "'")
            .slice(0, 1200);

          await interaction.editReply(
            `❌ I couldn't play that request.\n\n**Playback error:** \`${safeMessage}\`\n\nTry another song or link. If it still fails, send me this exact error text.`
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
