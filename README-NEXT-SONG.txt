bebot — Next Song Announcements (October 8, 2026)

This small update is based on the music.js from the most recent
bebot-soundcloud-relay-fix.zip. It does not modify your yt-dlp extractor,
DisTube music source plugins, audio relay, profile, or command definitions.

Changes:
- When DisTube emits PLAY_SONG for a subsequent track, bebot sends a small
  "Now Playing" embed to the same text channel used for /play.
- The initial /play song is not announced a second time, since /play
  already responds to that song.
- Includes the song title, artist, duration, and optional thumbnail.
- Logs a warning if missing channel permissions prevent announcements.
- Announcements happen for queued songs, skips, and autoplay recommendations.

INSTALL
1. Save a GitHub commit or Railway rollback point before changing files.
2. In GitHub aninipot repository, replace only music.js with this ZIP's file.
3. Commit and wait for Railway to deploy.
4. Test /play song1; then /play song2; /skip. Look for a Now Playing embed.
5. Then test /autoplay on (actual recommendations require available audio).

IMPORTANT
This update only announces a song after DisTube reports a PLAY_SONG event.
It does NOT fix YouTube 403, bot verification, missing playable sources, or
silent audio. If autoplay cannot find/start a recommendation, no Now Playing
message will be sent. Check Railway logs for that separate problem.
