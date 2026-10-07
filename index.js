import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits
} from "discord.js";
import { commandsJSON } from "./commands.js";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

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

client.on("error", console.error);

process.on("unhandledRejection", error => {
  console.error("Unhandled promise rejection:", error);
});

client.login(TOKEN);
