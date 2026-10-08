BEBOT — CLEAN NOW PLAYING MESSAGE UPDATE
========================================
This small update changes ONLY the /play Discord message format.
No changes to beatra_engine, your queue methods, profile, commands, or dependencies.

Changes:
- Replace "DisTube Playback Test" with "Now Playing".
- Show clickable song title, uploader/artist, and duration when available.
- Show album/video thumbnail when available.
- When another song is already playing, show "Added to Queue".
- Remove test instructions and the audio-source field.

HOW TO INSTALL
1) Extract this ZIP.
2) On GitHub, open your aninipot (bebot) repository.
3) Add file > Upload files.
4) Upload ONLY music.js from the extracted folder, replacing the old music.js.
5) Commit changes and let Railway redeploy bebot.
6) Test one /play command. If something fails, use the working Railway rollback.

IMPORTANT
Do not upload the README if you prefer only the changed code file.
The update has been syntax checked locally. We cannot verify live Discord audio here.
