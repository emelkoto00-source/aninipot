BEBOT DIS TUBE YOUTUBE-ONLY TEST — OCTOBER 2026

This ZIP was built from the user's submitted aninipot-main.zip and MusicBot-main(1).zip.
Only bebot's music backend is swapped; 25 command definitions are preserved.

Upload the CONTENTS of this ZIP into the ROOT of the existing aninipot (bebot)
GitHub repo, replacing same-named files. Do not create an extra enclosing folder.
Required Node runtime: 22.12+.

What changed:
- music.js: switches Shoukaku/Lavalink to DisTube with Beatra's custom yt-dlp
  extractor and relay; SoundCloud fallback is OFF for reliable diagnostics.
- index.js: same command handlers, modern clientReady event, updated help copy.
- commands.js: only /play description changed; 25 slash commands retained.
- package.json: DisTube, voice, ffmpeg-static, opusscript; removed shoukaku.
- beatra_engine/: small subset of MusicBot's MIT-licensed extractor, relay,
  binary setup, and dependencies (see LICENSE).
- .gitignore: ignore runtime-downloaded binaries and relay cache.

Test `/ping`, `/sticky` permissions, then `/play` a PUBLIC YouTube video 4-5min.
Be aware initial yt-dlp download can take a while on the Railway first boot.
The engine reports errors explicitly; it may still encounter YouTube IP blocks.
Do NOT remove the Lavalink Railway service until playback succeeds.
Stop/redeploy only bebot; do not run two simultaneous instances with its token.
No cookies or YouTube account credentials are needed for initial trial.

ROLLBACK: unzip bebot-before-distube-rollback.zip into the GitHub repo root,
replace existing files, then delete `beatra_engine/` directory (optional),
commit and deploy. Old Railway LAVALINK_* variables and the server stay intact.

Vendor: MusicBot/Beatra (c) original contributors, MIT. Source came from the
user's submitted GitHub ZIP. Security tweak: removed yt-dlp --no-check-certificates.
