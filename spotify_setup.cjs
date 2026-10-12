'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, 'beatra_engine/bin/spotify-soloist');
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { cwd: ROOT, env: { PATH: process.env.PATH, HOME: ROOT, DEBIAN_FRONTEND: 'noninteractive' }, stdio: 'ignore', ...options });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Spotify dependency setup timed out')); }, 180_000);
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Spotify setup failed (${path.basename(file)}: ${code})`)); });
  });
}
async function setup() {
  if (process.env.BEBOT_SPOTIFY !== '1') return;
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Spotify runtime requires Linux x64');
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  // Official builds expire after 90 days; refresh them on a new container startup.
  const binary = path.join(ROOT, 'soloist');
  if (!fs.existsSync(binary) || Date.now() - fs.statSync(binary).mtimeMs > 24 * 3600_000) {
    const response = await fetch('https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz', { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error('Official Spotify client download failed');
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > 50_000_000) throw new Error('Spotify archive exceeds expected size');
    fs.writeFileSync(path.join(ROOT, 'soloist.tar.gz'), archive, { mode: 0o600 });
    await run('tar', ['-xzf', 'soloist.tar.gz', 'soloist']);
    fs.chmodSync(binary, 0o700);
  }
  if (!fs.existsSync(path.join(ROOT, 'runtime/usr/bin/pulseaudio'))) {
    for (const name of ['packages/partial', 'lists/partial', 'runtime']) fs.mkdirSync(path.join(ROOT, name), { recursive: true });
    const options = ['-o', `Dir::State::Lists=${ROOT}/lists`, '-o', `Dir::Cache::Archives=${ROOT}/packages`];
    await run('apt-get', [...options, 'update', '-qq']);
    await run('apt-get', [...options, '--download-only', '-y', '--no-install-recommends', 'install', 'pulseaudio', 'pulseaudio-utils']);
    for (const file of fs.readdirSync(path.join(ROOT, 'packages')).filter(x => x.endsWith('.deb'))) {
      await run('dpkg-deb', ['-x', path.join(ROOT, 'packages', file), path.join(ROOT, 'runtime')]);
    }
  }
  console.log('[Spotify] Official client and audio runtime ready.');
}
module.exports = { setup, ROOT };
if (require.main === module) setup().catch(() => {
  // Spotify is optional. A setup failure must not prevent existing YouTube playback.
  console.error('[Spotify] Optional setup failed. YouTube playback remains available.');
});
