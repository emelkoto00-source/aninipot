BEBOT MUSIC CONTROLS + LISTENING PROFILE — STAGED UPDATE

IMPORTANT: Your currently working Railway rollback is not modified by downloading this ZIP.
This package was prepared against the user-uploaded YouTube-only DisTube files,
not against an exported snapshot of Railway's running container.

Install into your main aninipot repository (GitHub root). Keep folder structure:
  index.js                 REPLACE
  music.js                 REPLACE
  commands.js              REPLACE
  package.json             REPLACE (adds sharp for rendering)
  music_stats.js           ADD
  music_profile.js         ADD
  profile_background.png   ADD (the original supplied WELCOME TO INCB photo)

Do not replace/remove anything under beatra_engine/. No Spotify code is added.
No changes to yt-dlp, the relay, the YouTube extractor, or Lavalink are needed.

11 new slash commands on top of the existing 25:
/skip, /next, /pause, /resume, /queue [page], /nowplaying,
/autoplay on|off|status, /247 on|off|status, /volume [level],
/leave, /profile [user].

/profile: The profile shows individual listening time, Top Tracks and Top Friends.
Top Friends means members who listen together in voice. Does not access a
Discord private friends list. Statistics start at ZERO when the feature starts.
The card is created dynamically with the user's avatar and supplied background.

PERSISTENCE: by default stats are saved to <working directory>/data/listening-stats.json.
On Railway, filesystem changes may disappear at redeploy. To preserve history:
  add a Railway volume to the bebot SERVICE mounted at /app/data,
  and add BEBOT_DATA_DIR=/app/data to bebot variables.
You may test /profile without the volume, but stats may reset on redeploy.
NEVER check in the data folder containing member stats.

CAVEATS:
* /247 disables this bot's 2-minute idle-leave timer and keeps its current
  voice connection between songs when possible. Discord/Railway disconnects
  can still happen, and the setting resets after restart.
* /autoplay uses DisTube suggestions and may fail if YouTube blocks song access.
* This feature update has local syntax/command/card-render tests, but
  the new controls have NOT been tested in Railway/Discord.
* Your working version plays YouTube but may occasionally hit host/YouTube
  restrictions unrelated to these commands. This update cannot guarantee access.

SAFETY / DEPLOY:
  1. Keep your current successful Railway deployment in history.
  2. Download and preserve the separate pre-update backup ZIP.
  3. Check the contents of this update, then upload to your aninipot GitHub root.
  4. Commit and let Railway redeploy; watch for 'Registered 36 slash commands'
     and the usual DisTube 'Ready' message.
  5. TEST EXISTING /play FIRST with a direct YouTube URL.
  6. Then test /queue, /pause, /resume, /skip, /247, /profile.
  7. If something fails, roll back to the previously working Railway deployment.

NOTE: The old Lavalink variables are ignored by this build. Do not post secrets.
