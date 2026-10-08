import { AttachmentBuilder } from 'discord.js';
import { readFile } from 'node:fs/promises';

// A PNG attachment with live listening statistics. Not a static mockup.
const WIDTH = 1400, HEIGHT = 820;
const escapeSvg = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const truncate = (value, max) => { const s = String(value ?? ''); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const duration = ms => {
  const minutes = Math.floor(Math.max(0, ms || 0) / 60_000);
  const d = Math.floor(minutes / 1440), h = Math.floor(minutes % 1440 / 60), m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
};

async function avatarData(user) {
  try {
    const url = user.displayAvatarURL({ extension: 'png', size: 256 });
    const response = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!response.ok) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2_000_000) return '';
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch { return ''; }
}

export async function makeProfileCard(interaction, stats) {
  const [{ default: sharp }, background] = await Promise.all([
    import('sharp'),
    readFile(new URL('./profile_background.png', import.meta.url))
  ]);
  const user = interaction.options.getUser('user') || interaction.user;
  const data = stats.profile(interaction.guildId, user.id);
  const displayName = truncate(user.globalName || user.username, 26);
  const avatar = await avatarData(user);
  const names = await Promise.all(data.friends.map(async f => {
    try {
      const member = await interaction.guild.members.fetch(f.id);
      return truncate(member.displayName || member.user?.username || 'Member', 28);
    } catch { return `Member ${f.id.slice(-4)}`; }
  }));
  const text = (x,y,content,size=24,fill='#ffffff',weight=500) => `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeSvg(content)}</text>`;
  const row = (y,rank,label,ms,subtitle='') => `
    <rect x="43" y="${y-27}" width="595" height="66" rx="17" fill="#101223" fill-opacity=".78" stroke="#e68ed5" stroke-opacity=".32"/>
    <circle cx="76" cy="${y+5}" r="19" fill="${rank===1?'#e9bb63':rank===2?'#bfc2d4':'#cb977d'}"/>
    ${text(67,y+13,rank,21,'#211426',700)}
    ${text(110,y+1,truncate(label,34),20,'#ffffff',600)}
    ${subtitle?text(110,y+24,truncate(subtitle,45),14,'#c9c9df'):''}
    ${text(614,y+13,duration(ms),19,'#ffa1df',700).replace('x="614"','x="614" text-anchor="end"')}`;
  const panel = (y,heading,height) => `<rect x="25" y="${y}" width="631" height="${height}" rx="23" fill="#0d0e19" fill-opacity=".76" stroke="#f4a0e5" stroke-opacity=".82" stroke-width="2"/>${text(48,y+39,heading,25,'#ffd2f6',700)}`;
  const friends = data.friends.length ? data.friends.map((f,i)=>row(321+i*73,i+1,names[i],f.ms)).join('') : text(60,330,'No listening friends yet. Join voice and play music!',17,'#ebe5ef');
  const tracks = data.tracks.length ? data.tracks.map((t,i)=>row(619+i*69,i+1,t.name,t.ms,t.artist)).join('') : text(60,555,'No tracks recorded yet — start listening!',17,'#ebe5ef');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs><linearGradient id="dark" x1="0" x2="1"><stop offset="0" stop-color="#100d20" stop-opacity=".94"/><stop offset=".59" stop-color="#110e24" stop-opacity=".70"/><stop offset="1" stop-color="#121020" stop-opacity=".05"/></linearGradient><clipPath id="av"><circle cx="117" cy="118" r="73"/></clipPath></defs>
  <rect width="1400" height="820" fill="url(#dark)"/>
  <rect x="12" y="12" width="1376" height="796" rx="27" fill="none" stroke="#ffacdf" stroke-opacity=".84" stroke-width="3"/>
  <circle cx="117" cy="118" r="80" fill="#f3a1df" fill-opacity=".85"/>
  <circle cx="117" cy="118" r="74" fill="#242039"/>
  ${avatar?`<image href="${avatar}" x="44" y="45" width="146" height="146" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`:text(91,135,displayName.slice(0,1).toUpperCase(),57,'#fff',700)}
  ${text(223,108,displayName,39,'#fff',700)}
  ${text(225,143,'MUSIC LISTENING PROFILE',19,'#e5badf',600)}
  <rect x="226" y="161" width="395" height="48" rx="24" fill="#222038" fill-opacity=".87" stroke="#f4abdf"/>
  ${text(246,194,`TOTAL LISTENING  •  ${duration(data.totalMs)}`,19,'#ffd0ee',700)}
  ${panel(228,'TOP FRIENDS',297)}
  ${friends}
  ${panel(536,'TOP TRACKS',268)}
  ${tracks}
  </svg>`);
  const png = await sharp(background).resize(WIDTH, HEIGHT, { fit: 'cover' })
    .composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
  return new AttachmentBuilder(png, { name: 'bebot-profile.png' });
}
