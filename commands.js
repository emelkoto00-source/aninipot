import {
  SlashCommandBuilder,
  PermissionFlagsBits
} from "discord.js";

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check the bot latency."),

  new SlashCommandBuilder()
    .setName("hello")
    .setDescription("Get a greeting from the bot."),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show information about a user.")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("The user to inspect.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show information about this server."),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar.")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("The user whose avatar you want.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot repeat a message.")
    .addStringOption(option =>
      option
        .setName("message")
        .setDescription("The message to send.")
        .setRequired(true)
        .setMaxLength(1900)
    ),

  new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Send a simple embed.")
    .addStringOption(option =>
      option
        .setName("title")
        .setDescription("Embed title.")
        .setRequired(true)
        .setMaxLength(256)
    )
    .addStringOption(option =>
      option
        .setName("message")
        .setDescription("Embed message.")
        .setRequired(true)
        .setMaxLength(4000)
    ),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Flip a coin."),

  new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Roll a die.")
    .addIntegerOption(option =>
      option
        .setName("sides")
        .setDescription("Number of sides. Default: 6")
        .setRequired(false)
        .setMinValue(2)
        .setMaxValue(1000000)
    ),

  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the Magic 8-Ball a question.")
    .addStringOption(option =>
      option
        .setName("question")
        .setDescription("Your question.")
        .setRequired(true)
        .setMaxLength(1000)
    ),

  new SlashCommandBuilder()
    .setName("random")
    .setDescription("Generate a random whole number.")
    .addIntegerOption(option =>
      option
        .setName("min")
        .setDescription("Minimum number.")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("max")
        .setDescription("Maximum number.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("choose")
    .setDescription("Choose randomly from comma-separated options.")
    .addStringOption(option =>
      option
        .setName("options")
        .setDescription("Example: pizza, tacos, burgers")
        .setRequired(true)
        .setMaxLength(1500)
    ),

  new SlashCommandBuilder()
    .setName("joke")
    .setDescription("Send a random joke."),

  new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Send a random quote."),

  new SlashCommandBuilder()
    .setName("uptime")
    .setDescription("Show how long the bot has been online."),

  new SlashCommandBuilder()
    .setName("botinfo")
    .setDescription("Show information about the bot."),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available commands."),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play music using DisTube and yt-dlp.")
    .addStringOption(option =>
      option.setName("query")
        .setDescription("YouTube video link or song title and artist.")
        .setRequired(true)
        .setMaxLength(1000)
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the music and disconnect the bot from voice."),

  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song.'),
  new SlashCommandBuilder().setName('next').setDescription('Skip to the next queued song.'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause music playback.'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume paused music.'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue.')
    .addIntegerOption(option => option.setName('page').setDescription('Queue page').setMinValue(1).setRequired(false)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the song that is playing.'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Control automatic next-song recommendations.')
    .addStringOption(option => option.setName('mode').setDescription('Autoplay mode').setRequired(true)
      .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }, { name: 'Status', value: 'status' })),
  new SlashCommandBuilder().setName('247').setDescription('Keep bebot connected between tracks (best effort).')
    .addStringOption(option => option.setName('mode').setDescription('24/7 mode').setRequired(true)
      .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }, { name: 'Status', value: 'status' })),
  new SlashCommandBuilder().setName('volume').setDescription('Set music volume.')
    .addIntegerOption(option => option.setName('level').setDescription('Volume percentage, 0 to 150').setRequired(true).setMinValue(0).setMaxValue(150)),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect bebot from the voice channel.'),
  new SlashCommandBuilder().setName('profile').setDescription('View your listening profile with Top Friends and Top Tracks.')
    .addUserOption(option => option.setName('user').setDescription('Member to view').setRequired(false)),

  new SlashCommandBuilder()
    .setName("sticky")
    .setDescription("Keep a compact embed message at the bottom of this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(option =>
      option
        .setName("message")
        .setDescription("Main sticky text.")
        .setRequired(true)
        .setMaxLength(1500)
    )
    .addStringOption(option =>
      option
        .setName("link_url")
        .setDescription("Optional URL to make a clickable word.")
        .setRequired(false)
        .setMaxLength(1000)
    )
    .addStringOption(option =>
      option
        .setName("link_text")
        .setDescription("Clickable word. Default: here")
        .setRequired(false)
        .setMaxLength(80)
    )
    .addStringOption(option =>
      option
        .setName("after_link")
        .setDescription("Text shown after the clickable word.")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("unsticky")
    .setDescription("Remove the sticky message from this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Delete recent messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(option =>
      option
        .setName("amount")
        .setDescription("Number of messages to delete (1-100).")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Member to kick.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("reason")
        .setDescription("Reason for the kick.")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Member to ban.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("reason")
        .setDescription("Reason for the ban.")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily timeout a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Member to timeout.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("duration")
        .setDescription("Examples: 10m, 2h, 1d")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("reason")
        .setDescription("Reason for the timeout.")
        .setRequired(false)
        .setMaxLength(500)
    )
];

export const commandsJSON = commandBuilders.map(command => command.toJSON());
