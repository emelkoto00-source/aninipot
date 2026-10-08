bebot -- SoundCloud fallback safety repair (October 8, 2026)

What this update actually fixes:
- Rejects obviously different SoundCloud songs (e.g., 'Mine' selecting 'Wildest Dreams').
- Continues rejecting short previews (<60 seconds) and URLs that explicitly contain /preview/.
- Gives a clearer error when SoundCloud provides a DRM-protected stream.
- Delays next-song announcements briefly to avoid announcing a track whose queue failed immediately.

What it CANNOT fix:
- The YouTube 'Sign in to confirm you're not a bot' error, YouTube HTTP 403 responses,
  or SoundCloud tracks that are DRM-protected or otherwise unavailable.
- It does NOT provide a different licensed music catalog. Some requested songs will still fail.
- Automated matching is conservative, so it can decline valid alternatives when uncertain.

Files to upload to GitHub (aninipot repository only):
  music.js

Do not replace bebot's beatra_engine folder, profile, commands, or Railway variables.

Steps:
1. Keep Railway's previously working deployment available for rollback.
2. Extract the ZIP and upload music.js to the root of aninipot GitHub. Commit.
3. Wait for bebot Railway to redeploy.
4. Try a direct SoundCloud URL for a full-length, unprotected track and a song-title search.
5. If YouTube is rejected, this fix prevents a wrong/DRM alternative from being announced as playing;
   it cannot guarantee playable audio for that song.
6. If any existing function breaks, use Railway rollback (not just an identical source ZIP).

Do not share any Discord token, OAuth secret, cookies, or private signed media URLs in logs.
