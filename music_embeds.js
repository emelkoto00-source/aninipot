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
    .setAuthor({ name: 'bebot • music' })
    .setTitle(heading).setDescription(trackLink(song));
  const thumbnail = webUrl(song?.thumbnail);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}
export function buildNowPlayingEmbed(queue, song, { snapshot = false } = {}) {
  const embed = baseEmbed(song, queue?.paused ? '⏸ Paused' : '♫ Now Playing');
  const duration = song?.isLive ? 'LIVE' : Number(song?.duration) > 0 ? formatTime(song.duration) : 'Unknown';
  const voiceId = queue?.voiceChannel?.id;
  const waiting = Math.max(0, (queue?.songs?.length || 1) - 1);
  const source = ({ youtube: 'YouTube', soundcloud: 'SoundCloud' })[song?.source] || text(song?.source || 'Music');
  embed.addFields(
    { name: snapshot && !song?.isLive ? 'Position' : 'Duration', value: snapshot && !song?.isLive ? `${formatTime(queue?.currentTime)} / ${duration}` : duration, inline: true },
    { name: 'Requested by', value: requester(song), inline: true },
    { name: 'Voice channel', value: /^\d{17,20}$/.test(String(voiceId)) ? `<#${voiceId}>` : 'Voice chat', inline: true },
    { name: 'Source', value: source, inline: true },
    { name: 'Queue', value: `${waiting} waiting`, inline: true },
    { name: 'Autoplay', value: queue?.autoplay ? 'On' : 'Off', inline: true }
  );
  if (queue?.songs?.[1]) embed.addFields({ name: 'Up next', value: trackLink(queue.songs[1]) });
  return embed.setFooter({ text: snapshot ? 'Playback snapshot • /queue to see upcoming tracks' : 'Track started • /queue · /skip · /pause' });
}
export function buildRequestEmbed(song, { count = 1 } = {}) {
  return baseEmbed(song, '✓ Music Requested').addFields(
    { name: 'Duration', value: song?.isLive ? 'LIVE' : Number(song?.duration) > 0 ? formatTime(song.duration) : 'Unknown', inline: true },
    { name: 'Requested by', value: requester(song), inline: true }
  ).setFooter({ text: count > 1 ? `${count} tracks requested • New tracks are announced when they start` : 'New tracks are announced when they start' });
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
