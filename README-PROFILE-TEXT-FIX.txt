BEBOT /PROFILE TEXT FIX — OCTOBER 8, 2026

WHY THIS FIX EXISTS
The former profile used SVG <text> and depended on system fonts. Some Railway
containers have no available fonts, making the profile text disappear while
panels and rank circles still render.

THIS FIX
- New music_profile.js draws font outlines as SVG paths before Sharp renders.
- package.json adds fontkit and @fontsource/inter as normal npm dependencies.
- No system font installation is required.
- The profile background, current music history/statistics, and all music
  commands remain intact.
- This does NOT replace the working DisTube audio engine or change /play.

UPLOAD TO THE EXISTING 'aninipot' REPOSITORY (NOT LAVALINK)
1. Unzip this archive.
2. Upload ONLY music_profile.js and package.json at the GitHub repository ROOT,
   replacing the current files of the same names.
3. Do NOT upload a new bebot folder inside the existing repo.
4. Commit. Railway should rebuild and install the two new dependencies.
5. Wait for a successful deployment; try /profile in Discord.
6. Test /play once afterwards to make sure the current music system still works.

If /profile says a font package could not load, check Railway's Build Logs for
fontkit and @fontsource/inter installation errors. If deploy fails, restore the
previous working Railway deployment. Do not modify beatra_engine.

IMPORTANT HISTORY NOTE
Listening history only starts from when the music_stats tracker was deployed.
Older songs from before tracking cannot be reconstructed. Friends are members
who listen together in the same voice channel, not private Discord friends.
For stats to survive rebuilds, use a Railway volume and set BEBOT_DATA_DIR to
its mounted path, e.g. /app/data. A volume is NOT required to render the card.
