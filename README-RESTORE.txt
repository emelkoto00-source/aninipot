BEBOT — Restore the music.js used before the Now Playing / announcements / SoundCloud fallback patches

This is the EXACT music.js from the earlier bebot-music-controls-profile-update.zip (36-command phase).

It keeps the DisTube + yt-dlp engine, music controls, and listening stats integration.
It does NOT include next-song announcements, the newer SoundCloud fallback, or the compact Now Playing embed.
It does NOT modify beatra_engine, index.js, commands.js, package.json, or profile files.

Installation (GitHub aninipot repo):
1. Extract this ZIP.
2. Upload ONLY music.js to the root of the aninipot repository, replacing existing music.js.
3. Commit. Railway will redeploy.
4. Check bebot Deploy Logs for successful startup, then test /play with a song title and direct YouTube URL.
5. If YouTube still returns 'Sign in to confirm you are not a bot' or HTTP 403, that is source access denied; restoring code is not a guaranteed bypass.

DO NOT remove your other project files or change Railway settings.
