bebot - SoundCloud relay repair (October 8, 2026)

WHAT CHANGED
- music.js only. Uses Beatra RelayedSoundCloudPlugin instead of the plain SoundCloudPlugin.
- Rejects recognizable preview URLs before warming the local yt-dlp audio relay.
- Keeps the existing YouTube extractor and DisTube controls unchanged.
- Replaces the misleading "SoundCloud fallback OFF" test embed with a simple "Music Requested" acknowledgement.

INSTALL
1. Keep a backup and remember the existing Railway deployment that you can roll back to.
2. In aninipot GitHub, replace only the root music.js with this file.
3. Wait for bebot Railway to deploy. Test /play with a song title and then a direct public SoundCloud full track link.
4. Check logs for: [DisTube] SoundCloud audio relay ready: <title>
   If it is absent, the stream was not warmed. If it appears but there is no audio, send Deploy Logs.

IMPORTANT
YouTube HTTP 403 is caused by YouTube refusing audio requests and is NOT fixed by this patch.
SoundCloud full-length availability varies. A warmed stream is not proof of complete playback.
Please verify by listening for over a minute and to the end.

Rollback: restore your previous music.js or use Railway deployment rollback.
No variables or changes to beatra_engine, commands, profile or package.json required.
