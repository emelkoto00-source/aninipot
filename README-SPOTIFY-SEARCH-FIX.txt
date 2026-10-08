BEBOT — SPOTIFY SONG SEARCH FIX (October 2026)
===============================================

WHY SPOTIFY DID NOT PLAY
Your Spotify URL resolved to the correct song. MusicBot's YouTube plugin then
searched with yt-dlp using "ytsearch1:<song title>", and YouTube returned
"Sign in to confirm you're not a bot" from Railway.

A direct YouTube URL had already played successfully on this Railway service.
This fix adds an OPTIONAL official YouTube Data API v3 metadata search to find
video IDs, then keeps using the same working yt-dlp direct-video audio engine.
The Data API DOES NOT stream music and cannot guarantee any result is playable.

FILES TO UPLOAD TO YOUR MAIN GITHUB "aninipot" REPOSITORY
- music.js                                  (replace at repository root)
- beatra_engine/src/music/plugins.js        (replace inside that exact folder)

Do NOT upload this README unless you'd like it in your repository. Do not delete
other files or upload to the MusicBot or Lavalink repositories.

ONE RAILWAY VARIABLE YOU NEED FOR THE NEW SEARCH PATH
Name:  YOUTUBE_API_KEY
Value: Your own Google Cloud API key for YouTube Data API v3

How to obtain the API key:
1. Open https://console.cloud.google.com/ and sign into your Google account.
2. Select or create a Google Cloud project.
3. APIs & Services -> Library -> find "YouTube Data API v3" -> Enable.
4. APIs & Services -> Credentials -> Create credentials -> API key.
5. Restrict the key to YouTube Data API v3 (API restrictions). For a Railway
   server, browser/referrer restrictions won't work. IP restrictions only work
   if your Railway setup has stable outbound IPs.
6. In Railway -> bebot service -> Variables -> New Variable:
   YOUTUBE_API_KEY = (paste your key privately).
7. Redeploy bebot if Railway does not redeploy automatically.

Don't paste the API key in GitHub, Discord, or screenshots.
Default YouTube Data API quota is often 10,000 units/day, with search.list
costing 100 units per request; check your actual Google Cloud quota.

TESTS
A) In bebot Deploy Logs, look for:
   [DisTube trial] Ready. Spotify links enabled; YouTube metadata search: Data API v3; SoundCloud fallback OFF.
B) In Discord /play, paste a Spotify track URL. Wait for audio to begin and
   continue through the full song. A 'Loading audio' reply is NOT a success
   guarantee: the bot will now also post in Discord if stream retrieval fails.
C) After the track passes, test a public Spotify playlist with a few songs.
D) Try a direct YouTube URL; it should still work exactly as before.

If YOUTUBE_API_KEY is absent, the code keeps the old ytsearch method, which was
blocked on Railway, so Spotify links may continue to fail.
If the Spotify plugin cannot load a playlist, SPOTIFY_CLIENT_ID and
SPOTIFY_CLIENT_SECRET may also be needed (separate Spotify application).

ONLY the two JS files change. Existing 25 slash commands and all other files
are preserved. This update passed local tests but live Railway playback is
not yet verified.
