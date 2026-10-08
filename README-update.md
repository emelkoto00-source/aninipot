# bebot Lavalink update — changed files only

Replace `index.js`, `commands.js`, and `package.json` in the bebot GitHub repo.
**Add `music.js`** to the repo root.

Railway Variables for **bebot**:

- `DISCORD_TOKEN` (existing)
- `CLIENT_ID` (existing)
- `GUILD_ID` (existing)
- `LAVALINK_HOST=lavalink-bebot-production.up.railway.app`
- `LAVALINK_PORT=443`
- `LAVALINK_PASSWORD` (same secret used by Lavalink Railway service)
- `LAVALINK_SECURE=true`

The Lavalink Railway project keeps only `PORT=2333` and `LAVALINK_PASSWORD`, with Public Networking forwarding to port `2333`.

On startup look for `[Lavalink] Connected: railway-lavalink` in **bebot** deployment logs. If you see WebSocket errors or HTTP 401 in those logs, check the Lavalink password in both services. Do not share the password in screenshots.

Test `/play query: Taylor Swift Style` while inside a voice channel. `/stop` disconnects the bot. Spotify **track** URLs are resolved through metadata, then searched on YouTube/SoundCloud. Spotify itself does not provide a raw music stream.

**Important:** Successful Lavalink connection does not guarantee YouTube playback. The previous YouTube anti-bot challenge may still affect Railway; SoundCloud search is used as a fallback for song titles, not a guarantee. A `Sent to Lavalink` reply means the request was accepted, not necessarily that audible playback started. Read the Railway logs for `[Lavalink] Track started` and the Lavalink service logs for source errors.

If you changed the bot files yourself since the previous update, merge differences rather than overwriting custom code. This package starts from the last compact sticky version and preserves its 23 existing commands.
