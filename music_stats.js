import fs from 'node:fs';
import path from 'node:path';

// Voice-channel co-listening statistics. Nobody's Discord private friends list is read.
// Records only while DisTube reports an active, unpaused song.
const TICK_MS = 20_000;
const MAX_INTERVAL_MS = 25_000;
const MAX_TRACKS_PER_USER = 200;
const safeString = (x, n = 160) => String(x || '').slice(0, n);

export function createListeningStats(client, getPlayer) {
  const root = path.resolve(process.env.BEBOT_DATA_DIR || path.join(process.cwd(), 'data'));
  const file = path.join(root, 'listening-stats.json');
  let data = { version: 1, guilds: {} };
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded?.version === 1 && loaded?.guilds && typeof loaded.guilds === 'object') data = loaded;
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Music stats] Could not load saved stats:', error.message);
  }
  let dirty = false;
  let writing = Promise.resolve();
  function save() {
    if (!dirty) return writing;
    dirty = false;
    const payload = JSON.stringify(data);
    writing = writing.catch(() => {}).then(async () => {
      try {
        await fs.promises.mkdir(root, { recursive: true });
        const temp = file + '.tmp';
        await fs.promises.writeFile(temp, payload, { mode: 0o600 });
        await fs.promises.rename(temp, file);
      } catch (err) {
        console.error('[Music stats] Save failed:', err.message);
        dirty = true;
      }
    });
    return writing;
  }
  function userStats(guildId, userId) {
    const guild = (data.guilds[guildId] ??= { users: {} });
    return (guild.users[userId] ??= { totalMs: 0, tracks: {}, friends: {} });
  }
  function record(guildId, ids, song, ms) {
    if (!guildId || !ids.length || !Number.isFinite(ms) || ms <= 0 || !song) return;
    const id = safeString(song.url || `${song.name}|${song.uploader?.name || ''}`, 300);
    for (const userId of ids) {
      const stats = userStats(guildId, userId);
      stats.totalMs += ms;
      const entry = (stats.tracks[id] ??= {
        name: safeString(song.name || 'Unknown song'),
        artist: safeString(song.uploader?.name || song.uploader || '', 80),
        url: safeString(song.url, 300), ms: 0
      });
      entry.ms += ms;
      for (const friendId of ids) {
        if (friendId !== userId) stats.friends[friendId] = (stats.friends[friendId] || 0) + ms;
      }
      const keys = Object.keys(stats.tracks);
      if (keys.length > MAX_TRACKS_PER_USER) {
        keys.sort((a,b) => stats.tracks[a].ms - stats.tracks[b].ms);
        for (const key of keys.slice(0, keys.length - MAX_TRACKS_PER_USER)) delete stats.tracks[key];
      }
    }
    dirty = true;
  }
  let lastSample = Date.now();
  function tick() {
    const now = Date.now();
    const ms = Math.max(0, Math.min(now - lastSample, MAX_INTERVAL_MS));
    lastSample = now;
    if (ms === 0) return;
    const player = getPlayer();
    if (!player) return;
    for (const [guildId, guild] of client.guilds.cache) {
      const queue = player.getQueue(guildId);
      if (!queue || queue.paused || !queue.playing || !queue.songs?.[0]) continue;
      const voice = queue.voiceChannel || guild.channels.cache.get(player.voices.get(guildId)?.channelId);
      if (!voice?.members) continue;
      const listeners = [...voice.members.values()].filter(member => !member.user?.bot).map(member => member.id);
      record(guildId, listeners, queue.songs[0], ms);
    }
  }
  const ticker = setInterval(tick, TICK_MS);
  ticker.unref?.();
  const saver = setInterval(() => void save(), 60_000);
  saver.unref?.();
  function profile(guildId, userId) {
    const stats = data.guilds[guildId]?.users?.[userId];
    if (!stats) return { totalMs: 0, tracks: [], friends: [] };
    return {
      totalMs: stats.totalMs || 0,
      tracks: Object.values(stats.tracks || {}).sort((a,b) => b.ms - a.ms).slice(0,3),
      friends: Object.entries(stats.friends || {}).sort((a,b) => b[1] - a[1]).slice(0,3).map(([id,ms]) => ({ id, ms }))
    };
  }
  return { profile, flush: save, _recordForTests: record, _tickForTests: tick };
}
