# Original Spotify audio

Optional Spotify playback uses Spotify's official Soloist Linux client and a private PulseAudio sink. It does not search YouTube for a replacement. Existing YouTube/SoundCloud queues keep their current engine.

Private Railway variables:

- `BEBOT_SPOTIFY=1`
- `SPOTIFY_SOLOIST_API_KEY`: the account owner's Soloist key
- `BEBOT_SPOTIFY_STATE`: gzip/base64 JSON containing the paired Soloist device's small settings and authentication files

Never commit these values, pairing archives, or runtime data. Pair Soloist on the owner's local network first. The generated runtime and private state live inside the existing ignored `beatra_engine/bin/` and `beatra_engine/data/` directories. No public audio or control port is exposed. Dependency setup uses official Spotify downloads and the container's configured Debian repositories.

`/play` accepts full `https://open.spotify.com/track/...`, `/album/...`, and `/playlist/...` links, including `intl-xx` paths, and matching Spotify URIs. Tracks and playlists retain their Spotify identity. A new-track announcement contains the title, duration, requester, and artwork.

Spotify sessions support `/pause`, `/resume`, `/skip`, `/next`, `/stop`, `/leave`, `/volume`, `/queue`, `/nowplaying`, and `/247`. Individual track requests can be added to a running Spotify queue. Use `/stop` before switching between Spotify and YouTube/SoundCloud, or starting another playlist/album. One Spotify account serves one voice channel at a time. Spotify manages its own recommendations; `/autoplay` remains a YouTube control.

The listening profile counts Spotify tracks and Spotify autoplay for human members in the bot's voice channel while audio is playing. Paused, buffering, and disconnected sessions do not earn time. The tracker samples every 20 seconds and saves every minute to `BEBOT_DATA_DIR` (default `./data`). Mount persistent storage at that directory to retain profiles across deployments. Listening before this integration was enabled cannot be reconstructed.

The client restores its approved pairing after a container replacement. Builds expire after 90 days; the official client is refreshed at startup when the locally cached build is older than a day. If the pairing is revoked, pair again and replace the private state. An optional Spotify setup failure does not stop the bot's existing YouTube startup.

Validation: `node --test tests/*.test.*` and `TEST_FFMPEG_PATH=/path/to/ffmpeg node tests/regression.mjs` on Linux. Live source checks must verify actual non-silent audio and advancing playback; accepting a control command alone is not proof of playback.
