import { EmbedBuilder, escapeMarkdown } from 'discord.js';

const COLOR = 0xED91CF;
const text = (value, limit = 160) => escapeMarkdown(String(value || 'Unknown').replace(/[\r\n\t]/g, ' ').slice(0, limit));
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href.replaceAll('(', '%28').replaceAll(')', '%29');
  } catch { return undefined; }
}
function trackLink(song) {
  const title = text(song?.name || 'Unknown track');
  const url = webUrl(song?.url);
  const link = url ? `[${title}](${url})` : title;
  return link.length <= 1024 ? link : title;
}
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!Number.isFinite(total)) return '0:00';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(total % 60).padStart(2, '0')}`;
}
function requester(song) {
  if (song?.member?.user?.bot) return 'Autoplay';
  const id = song?.metadata?.requesterId || song?.member?.id;
  return /^\d{17,20}$/.test(String(id)) ? `<@${id}>` : 'Autoplay / unknown';
}
function baseEmbed(song, heading) {
  const embed = new EmbedBuilder().setColor(COLOR)
    .setTitle(heading).setDescription(trackLink(song));
  const thumbnail = webUrl(song?.thumbnail);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}
export function buildNowPlayingEmbed(queue, song, { status } = {}) {
  const heading = status || (queue?.paused ? '⏸ Paused' : queue?.buffering ? '⌛ Buffering' : '♫ Now Playing');
  const embed = baseEmbed(song, heading).setColor(song?.source === 'spotify' ? 0x1DB954 : COLOR);
  const duration = song?.isLive ? 'LIVE' : Number(song?.duration) > 0 ? formatTime(song.duration) : 'Unknown';
  const total = Number(song?.duration) || 0;
  const elapsed = Math.max(0, Math.min(Number(queue?.currentTime) || 0, total || Infinity));
  const filled = total > 0 ? Math.min(12, Math.floor(elapsed / total * 12)) : 0;
  const progress = song?.isLive ? '🔴 LIVE' : `${'▰'.repeat(filled)}${'▱'.repeat(12-filled)}\n\`${formatTime(elapsed)} / ${duration}\`${total > 0 ? ` · ${formatTime(total-elapsed)} left` : ''}`;
  return embed.setDescription(`${trackLink(song)}\n${progress}\n${requester(song)}`);
}
export function buildRequestEmbed(song, { count = 1 } = {}) {
  const duration = song?.isLive ? 'LIVE' : Number(song?.duration) > 0 ? formatTime(song.duration) : 'Unknown';
  return baseEmbed(song, '✓ Music Requested')
    .setDescription(`${trackLink(song)}\n${duration} · ${requester(song)}${count > 1 ? ` · ${count} tracks` : ''}`);
}

// Presentation only: never await this from the player's event callback.
// Embed validation, synchronous send errors and rejected sends are all contained.
export async function announceNowPlaying(queue, song, report = () => {}) {
  try {
    if (!queue?.textChannel?.send) return;
    await queue.textChannel.send({
      embeds: [buildNowPlayingEmbed(queue, song)],
      allowedMentions: { parse: [], repliedUser: false }
    });
  } catch {
    try { report('notification', { stage: 'now_playing', outcome: 'failed', reason: 'NOTICE_FAILED' }); } catch { /* diagnostics must not affect playback */ }
  }
}

// One message per track, with bounded edit frequency. Discord failures never reach audio code.
export function createNowPlayingAnnouncer({ intervalMs = 5000, schedule = setInterval, cancel = clearInterval } = {}) {
  const entries = new Map();
  function stop(key, status = '⏹ Stopped') {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key); cancel(entry.timer);
    let view = entry.last || {};
    try { view = entry.read() || view; } catch { /* retain last snapshot */ }
    if (status === '✓ Finished') view = { ...view, currentTime: entry.song.duration };
    entry.final = buildNowPlayingEmbed(view, entry.song, { status });
    void entry.tail.then(() => entry.message?.edit({ embeds: [entry.final], allowedMentions: { parse: [] } })).catch(() => {});
  }
  function start(key, channel, song, read) {
    stop(key, '✓ Finished');
    if (!channel?.send) return;
    const entry = { song, read, last: {}, tail: Promise.resolve(), busy: false };
    entries.set(key, entry);
    const refresh = async () => {
      if (entry.busy || entries.get(key) !== entry) return;
      entry.busy = true;
      try {
        const view = read();
        if (!view) { stop(key); return; }
        entry.last = { ...view };
        const embed = buildNowPlayingEmbed(view, song), json = JSON.stringify(embed.toJSON());
        if (entry.rendered === json) return;
        const payload = { embeds: [embed], allowedMentions: { parse: [], repliedUser: false } };
        if (entry.message) await entry.message.edit(payload);
        else entry.message = await channel.send(payload);
        entry.rendered = json;
      } catch {
        // Deleted messages / lost permissions must not cause endless retries or interrupt playback.
        if (entries.get(key) === entry) { entries.delete(key); cancel(entry.timer); }
      } finally { entry.busy = false; }
    };
    entry.timer = schedule(() => { if (!entry.busy) entry.tail = refresh(); }, intervalMs); entry.timer?.unref?.();
    entry.tail = refresh();
  }
  return { start, stop, close() { for (const key of [...entries.keys()]) stop(key); } };
}
