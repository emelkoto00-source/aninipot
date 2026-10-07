# Railway Discord Bot

A basic Discord bot using `discord.js` with 21 slash commands.

## Commands

- `/ping`
- `/hello`
- `/userinfo [user]`
- `/serverinfo`
- `/avatar [user]`
- `/say <message>`
- `/embed <title> <message>`
- `/coinflip`
- `/roll [sides]`
- `/8ball <question>`
- `/random <min> <max>`
- `/choose <options>`
- `/joke`
- `/quote`
- `/uptime`
- `/botinfo`
- `/help`
- `/sticky <message>`
- `/unsticky`
- `/clear <amount>`
- `/kick <user> [reason]`
- `/ban <user> [reason]`
- `/timeout <user> <duration> [reason]`

Moderation commands use Discord permission checks.

## 1. Create the Discord application

Go to the Discord Developer Portal:

https://discord.com/developers/applications

Create a new application, then open **Bot** and create/add the bot.

Copy your bot token. Keep it private.

## 2. Enable the required privileged intent

In the application's **Bot** page, find **Privileged Gateway Intents**.

Enable:

- **Server Members Intent**

Save changes.

## 3. Get your Application / Client ID

Open **General Information** and copy the **Application ID**.

This is your `CLIENT_ID`.

## 4. Optional: Get your Server / Guild ID

For faster slash-command updates during testing:

1. Discord Settings → Advanced → enable Developer Mode.
2. Right-click your server.
3. Choose **Copy Server ID**.

This is your `GUILD_ID`.

If you provide `GUILD_ID`, commands are registered only in that server and usually appear very quickly.

If you leave `GUILD_ID` blank, commands are registered globally and can take longer to update.

## 5. Invite the bot

In the Developer Portal, use **OAuth2 → URL Generator**.

Select:

- `bot`
- `applications.commands`

Recommended bot permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Messages
- Kick Members
- Ban Members
- Moderate Members

Only give the bot permissions you actually want it to have.

## 6. Upload this project to GitHub

Upload:

- `index.js`
- `commands.js`
- `register-commands.js`
- `package.json`
- `.gitignore`
- `.env.example`
- `README.md`

Never upload your actual bot token.

## 7. Deploy on Railway

1. Create a new Railway project.
2. Choose **Deploy from GitHub Repo**.
3. Select this repository.
4. Open the service.
5. Go to **Variables**.
6. Add:

   `DISCORD_TOKEN` = your Discord bot token

   `CLIENT_ID` = your Discord application ID

   `GUILD_ID` = your Discord server ID (recommended while testing)

7. Railway should automatically run:

   `npm start`

You do not need a public Railway domain for this bot because it connects outbound to Discord.

## Moderation notes

The bot's Discord role must be ABOVE the roles of members it needs to kick, ban, or timeout.

`/clear` can only bulk-delete messages newer than 14 days due to Discord limitations.

`/timeout` accepts:

- `30s`
- `10m`
- `2h`
- `1d`

Maximum timeout duration is 28 days.

## Security

Never put your token directly inside `index.js`.

If your token is ever exposed, reset it immediately in the Discord Developer Portal.


## Sticky messages

Use `/sticky <message>` to create or replace a sticky message in the current channel.

Use `/unsticky` to remove it.

Whenever a non-bot user sends a message, the bot briefly waits, deletes the old sticky,
and reposts it at the bottom. Only members with **Manage Messages** can use these commands.

Sticky configuration is stored in memory. If Railway restarts or redeploys the bot,
run `/sticky` again in that channel.


### Sticky channel permissions

The bot needs **View Channel** and **Send Messages** in any channel where `/sticky` is used.
The user running `/sticky` or `/unsticky` needs **Manage Messages**.


### Sticky embed design

`/sticky` now sends the sticky as a Discord **embed** instead of plain text.

Design used:
- Title: `📌 Sticky Message`
- Accent color: purple
- Description: your sticky text
- Footer: `Auto-sticky • stays at the bottom of the channel`


## Compact sticky embed

The sticky now uses a compact Discord embed with no title, footer, or timestamp.

Example:

`/sticky message:thx 4 partnering w us !! 🐷 link_url:https://discord.com/channels/... link_text:here after_link:to partner >.<`

This renders approximately as:

thx 4 partnering w us !! 🐷  
click **here** to partner >.<

The word `here` is a masked clickable hyperlink, so Discord shows the destination URL on hover.
