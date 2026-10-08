import { AttachmentBuilder } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Font-independent profile rendering: SVG text rendered as vector glyph outlines.
// Railway's minimal containers often have no installed fontconfig fonts. SVG <text>
// may then be invisible. Fontkit reads the open-source Inter WOFF installed by npm
// and converts the text to SVG <path> elements before Sharp composites the card.
const require = createRequire(import.meta.url);
const WIDTH = 1400;
const HEIGHT = 820;
const truncate = (value, max) => {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return Array.from(s).length > max ? `${Array.from(s).slice(0, max - 1).join('')}…` : s;
};
const duration = ms => {
  const minutes = Math.floor(Math.max(0, Number(ms) || 0) / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor(minutes % 1440 / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
};

let fontPromise;
async function loadFonts() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const fontkitModule = await import('fontkit');
      const fontkit = fontkitModule.default || fontkitModule;
      const root = new URL('./node_modules/@fontsource/inter/files/', import.meta.url);
      const [regular, bold] = await Promise.all([
        readFile(new URL('inter-latin-400-normal.woff', root)),
        readFile(new URL('inter-latin-700-normal.woff', root))
      ]);
      return { regular: fontkit.create(regular), bold: fontkit.create(bold) };
    })().catch(error => {
      fontPromise = null;
      throw new Error(`Profile fonts could not load. Check that @fontsource/inter and fontkit are installed. ${error.message}`);
    });
  }
  return fontPromise;
}

// Returns SVG paths, not an SVG <text> element. Rendering will work without
// system fonts, even inside slim Railway/Docker containers.
function makePainter(fonts) {
  function draw(x, y, value, px = 24, fill = '#ffffff', weight = 400, anchor = 'start') {
    const font = weight >= 600 ? fonts.bold : fonts.regular;
    // Inter Latin supports English, basic accented Latin, and punctuation.
    const content = truncate(value, 110).replace(/[\uFE0E\uFE0F]/g, '');
    const layout = font.layout(content);
    const size = px / font.unitsPerEm;
    const advance = layout.positions.reduce((sum, item) => sum + item.xAdvance, 0) * size;
    const left = anchor === 'end' ? x - advance : anchor === 'middle' ? x - advance / 2 : x;
    let cursor = 0;
    const paths = [];
    for (let i = 0; i < layout.glyphs.length; i++) {
      const glyph = layout.glyphs[i];
      const position = layout.positions[i];
      const d = glyph.path.toSVG();
      // Missing glyphs are not displayed as enormous tofu boxes; other glyphs remain.
      if (d && glyph.id !== 0) {
        paths.push(`<path transform="translate(${cursor + position.xOffset},${position.yOffset})" d="${d}"/>`);
      }
      cursor += position.xAdvance;
    }
    return `<g fill="${fill}" transform="translate(${left.toFixed(2)},${y.toFixed(2)}) scale(${size.toFixed(7)},-${size.toFixed(7)})">${paths.join('')}</g>`;
  }
  return draw;
}

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
  const [{ default: sharp }, background, fonts] = await Promise.all([
    import('sharp'),
    readFile(new URL('./profile_background.png', import.meta.url)),
    loadFonts()
  ]);
  const paint = makePainter(fonts);
  const user = interaction.options.getUser('user') || interaction.user;
  const data = stats.profile(interaction.guildId, user.id);
  const displayName = truncate(user.globalName || user.username, 26);
  const avatar = await avatarData(user);
  const names = await Promise.all(data.friends.map(async f => {
    try {
      const member = await interaction.guild.members.fetch(f.id);
      return truncate(member.displayName || member.user?.username || 'Member', 28);
    } catch { return `Member ${String(f.id).slice(-4)}`; }
  }));

  function row(y, rank, label, ms, subtitle = '') {
    // Leave plenty of room at the right for listening duration.
    const leftLabel = truncate(label, 34);
    return `<rect x="43" y="${y - 27}" width="595" height="66" rx="17" fill="#101223" fill-opacity=".86" stroke="#e68ed5" stroke-opacity=".32"/>
      <circle cx="76" cy="${y + 5}" r="19" fill="${rank === 1 ? '#e9bb63' : rank === 2 ? '#bfc2d4' : '#cb977d'}"/>
      ${paint(76, y + 13, rank, 21, '#211426', 700, 'middle')}
      ${paint(110, y + 1, leftLabel, 20, '#ffffff', 700)}
      ${subtitle ? paint(110, y + 24, truncate(subtitle, 42), 14, '#c9c9df') : ''}
      ${paint(614, y + 13, duration(ms), 19, '#ffa1df', 700, 'end')}`;
  }
  function panel(y, heading, height) {
    return `<rect x="25" y="${y}" width="631" height="${height}" rx="23" fill="#0d0e19" fill-opacity=".80" stroke="#f4a0e5" stroke-opacity=".82" stroke-width="2"/>${paint(48, y + 39, heading, 25, '#ffd2f6', 700)}`;
  }
  const friends = data.friends.length
    ? data.friends.map((f, i) => row(321 + i * 73, i + 1, names[i], f.ms)).join('')
    : paint(60, 330, 'No listening friends yet. Play music together!', 17, '#ebe5ef');
  const tracks = data.tracks.length
    ? data.tracks.map((t, i) => row(619 + i * 69, i + 1, t.name, t.ms, t.artist)).join('')
    : paint(60, 595, 'No tracks recorded yet. Start listening!', 17, '#ebe5ef');

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs><linearGradient id="dark" x1="0" x2="1"><stop offset="0" stop-color="#100d20" stop-opacity=".94"/><stop offset=".59" stop-color="#110e24" stop-opacity=".70"/><stop offset="1" stop-color="#121020" stop-opacity=".05"/></linearGradient><clipPath id="av"><circle cx="117" cy="118" r="73"/></clipPath></defs>
    <rect width="1400" height="820" fill="url(#dark)"/>
    <rect x="12" y="12" width="1376" height="796" rx="27" fill="none" stroke="#ffacdf" stroke-opacity=".84" stroke-width="3"/>
    <circle cx="117" cy="118" r="80" fill="#f3a1df" fill-opacity=".85"/>
    <circle cx="117" cy="118" r="74" fill="#242039"/>
    ${avatar ? `<image href="${avatar}" x="44" y="45" width="146" height="146" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>` : paint(117, 138, displayName.slice(0, 1).toUpperCase(), 57, '#fff', 700, 'middle')}
    ${paint(223, 108, displayName, 39, '#fff', 700)}
    ${paint(225, 143, 'MUSIC LISTENING PROFILE', 19, '#e5badf', 700)}
    <rect x="226" y="161" width="395" height="48" rx="24" fill="#222038" fill-opacity=".87" stroke="#f4abdf"/>
    ${paint(246, 194, `TOTAL LISTENING  -  ${duration(data.totalMs)}`, 19, '#ffd0ee', 700)}
    ${panel(228, 'TOP FRIENDS', 297)}${friends}
    ${panel(536, 'TOP TRACKS', 268)}${tracks}
    </svg>`);
  const png = await sharp(background).resize(WIDTH, HEIGHT, { fit: 'cover' })
    .composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
  return new AttachmentBuilder(png, { name: 'bebot-profile.png' });
}
