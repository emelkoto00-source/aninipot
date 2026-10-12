'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const { setup, ROOT } = require('./spotify_setup.cjs');

function restoreState(encoded, root) {
  const files = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 256_000 }).toString('utf8'));
  if (!files || Array.isArray(files) || Object.keys(files).length > 100) throw new Error('Invalid Spotify session');
  for (const [name, value] of Object.entries(files)) {
    if (!/^(?:\.device_id|(?:settings|cache)\/[A-Za-z0-9_./-]+)$/.test(name) || name.split('/').some(x => x === '..' || x === '.')) throw new Error('Unsafe Spotify session path');
    if (typeof value !== 'string' || value.length > 100_000) throw new Error('Invalid Spotify session entry');
    const target = path.resolve(root, name);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe Spotify session path');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(value, 'base64'), { mode: 0o600 });
  }
}

async function start() {
  if (!process.env.SPOTIFY_SOLOIST_API_KEY || !process.env.BEBOT_SPOTIFY_STATE) throw new Error('Spotify private setup is missing');
  await setup();
  const dir = path.resolve(__dirname, 'beatra_engine/data/spotify');
  for (const sub of ['', 'data', 'run', 'home', 'cache']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  const data = path.join(dir, 'data');
  if (!fs.existsSync(path.join(data, '.initialized'))) {
    restoreState(process.env.BEBOT_SPOTIFY_STATE, data);
    fs.writeFileSync(path.join(data, '.initialized'), '1', { mode: 0o600 });
  }
  const library = path.join(ROOT, 'runtime/usr/lib/x86_64-linux-gnu');
  const pulseRoot = fs.readdirSync(path.join(ROOT, 'runtime/usr/lib')).find(x => x.startsWith('pulse-'));
  if (!pulseRoot) throw new Error('PulseAudio modules missing');
  const modules = path.join(ROOT, 'runtime/usr/lib', pulseRoot, 'modules');
  const socket = path.join(dir, 'run/pulse.sock');
  const env = { PATH: process.env.PATH, HOME: path.join(dir, 'home'), XDG_RUNTIME_DIR: path.join(dir, 'run'),
    LD_LIBRARY_PATH: [library, path.join(library, 'pulseaudio'), modules].join(':'),
    PULSE_SERVER: `unix:${socket}`, PULSE_SINK: 'spotify_bebot' };
  fs.writeFileSync(path.join(dir, 'pulse.pa'), `load-module module-native-protocol-unix socket=${socket}\nload-module module-null-sink sink_name=spotify_bebot rate=48000 channels=2\nset-default-sink spotify_bebot\n`, { mode: 0o600 });
  const children = [];
  const launch = (file, args) => {
    const p = spawn(file, args, { env, stdio: 'ignore' });
    children.push(p); p.on('error', () => {}); return p;
  };
  const close = async () => { for (const child of children) child.kill('SIGTERM'); };
  try {
    const pulse = launch(path.join(ROOT, 'runtime/usr/bin/pulseaudio'), ['-n', '-F', path.join(dir, 'pulse.pa'), '-p', modules, '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=no']);
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(socket)) break;
      if (pulse.exitCode != null) throw new Error('PulseAudio failed');
      await new Promise(r => setTimeout(r, 100));
    }
    if (!fs.existsSync(socket)) throw new Error('PulseAudio timed out');
    const soloist = launch(path.join(ROOT, 'soloist'), ['--device-name', 'Bebot Spotify', '--api-key', process.env.SPOTIFY_SOLOIST_API_KEY,
      '--data-dir', data, '--cache-dir', path.join(dir, 'cache'), '--cache-size', '100', '--ws', '127.0.0.1:3678']);
    const { SoloistControl } = await import('./spotify_music.js');
    const control = new SoloistControl('ws://127.0.0.1:3678');
    for (let i = 0; i < 20; i++) {
      if (soloist.exitCode != null) throw new Error('Spotify client failed');
      const auth = await control.request('get_auth_state').catch(() => null);
      if (auth?.logged_in) return { control, env, parec: path.join(ROOT, 'runtime/usr/bin/parec'), close };
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Spotify session needs pairing');
  } catch (error) { await close(); throw error; }
}
module.exports = { start, restoreState };
