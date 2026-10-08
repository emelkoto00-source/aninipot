bebot playback recovery (October 8, 2026)

This is a targeted playback-source fallback built from the first Music Controls + Profile update,
not from the Spotify or Lavalink revisions.

ZIP CONTENTS:
 - music.js (the only application file to upload)
 - README-RECOVERY.txt (this guide; optional)

INSTALL ON GITHUB:
1) Save a copy of your current music.js or retain your Railway rollback deployment.
2) Open the aninipot GitHub repository, NOT lavalink-bebot and NOT MusicBot.
3) Replace only music.js at the repository ROOT (not inside beatra_engine).
4) Commit once; wait for the bebot Railway service to redeploy.
5) Check Deploy Logs for:
   [DisTube] Executables ready. YouTube first, SoundCloud preview guard enabled.
6) Test /play with a SONG TITLE first, then a DIRECT SoundCloud track URL.
7) A YouTube URL will still use YouTube. If the Railway IP is challenged by YouTube,
   direct YouTube audio cannot be guaranteed by this update.

HOW IT WORKS:
 - The previous working YouTube extractor and yt-dlp code remain untouched.
 - Song-title searches try YouTube first and search SoundCloud if YouTube fails.
 - SoundCloud streams with visible /preview/ paths or type=preview are rejected.
 - SoundCloud search results with metadata durations below 60s are rejected.
 - These checks can identify known preview formats but cannot guarantee every
   provider URL contains full-length audio. Verify the first complete song.
 - Direct SoundCloud track links are accepted (Spotify links remain disabled).
 - The full list of 36 commands, profile, sticky messages, and moderation commands
   are not changed by this update.

IF THE BOT DOES NOT START OR PLAY:
 - In Railway, inspect the deployment log lines after /play.
 - Roll back to the known-good deployment using Railway Deployments > Rollback.
 - Send the failure lines. No tokens/passwords needed.

This patch cannot force YouTube to accept requests from a cloud datacenter IP.
It is a source fallback and preview guard, not a bypass or guaranteed YouTube fix.
