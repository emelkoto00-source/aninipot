'use strict';

// Pinned provider recommended by https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide.
// Runs on demand; no public service, account cookies, or alternate uploads.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { extractZip } = require('./beatra_engine/src/core/unzip');
const VERSION = '2.0.2';
const SOURCE_HASH = 'df68ee6210e4960757bceae298927fb2ebd4d5cd9d390f9ff3a8287b0d2d1054';
const PLUGIN_HASH = 'a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef';
const BASE = path.resolve(__dirname, 'beatra_engine', process.env.BIN_DIR || 'bin');
const ROOT = path.join(BASE, `bgutil-${VERSION}`);
const serverHome = root => path.join(root, `bgutil-ytdlp-pot-provider-${VERSION}`, 'server');
const enabled = () => process.env.BEBOT_YOUTUBE_PROVIDER !== 'off';

function ready(root = ROOT) {
    try {
        return fs.readFileSync(path.join(root, 'ready'), 'utf8') === `${SOURCE_HASH}:${PLUGIN_HASH}` &&
            fs.existsSync(path.join(serverHome(root), 'build', 'generate_once.js')) &&
            fs.existsSync(path.join(serverHome(root), 'node_modules', 'canvas', 'package.json')) &&
            fs.existsSync(path.join(root, 'plugins', 'bgutil.zip'));
    } catch { return false; }
}

function providerArgs({ root = ROOT, useProvider = enabled() } = {}) {
    if (!useProvider || !ready(root)) return [];
    return ['--plugin-dirs', path.join(root, 'plugins'),
        '--extractor-args', 'youtube:player_client=mweb',
        '--extractor-args', `youtubepot-bgutilscript:server_home=${serverHome(root)}`];
}

async function verifiedDownload(url, expectedHash) {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`Provider download failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== expectedHash) throw new Error('Provider checksum mismatch');
    return data;
}

function run(args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
        const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Provider setup process exited ${code}`)); });
    });
}

async function setup() {
    if (!enabled()) return console.log('[YouTube] Token provider disabled by configuration.');
    if (ready()) return console.log(`[YouTube] Token provider ${VERSION} ready.`);
    if (!process.env.npm_execpath) throw new Error('Run provider setup through npm run build or npm start.');
    fs.mkdirSync(BASE, { recursive: true });
    const staging = fs.mkdtempSync(path.join(BASE, '.bgutil-'));
    // All installer writes and cleanup stay in the generated bin directory.
    const clean = target => {
        if (path.dirname(path.resolve(target)) !== BASE) throw new Error('Unsafe provider cleanup path');
        fs.rmSync(target, { recursive: true, force: true });
    };
    try {
        console.log(`[YouTube] Preparing token provider ${VERSION}...`);
        const source = await verifiedDownload(`https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${VERSION}.zip`, SOURCE_HASH);
        const plugin = await verifiedDownload(`https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${VERSION}/bgutil-ytdlp-pot-provider.zip`, PLUGIN_HASH);
        extractZip(source, staging);
        fs.mkdirSync(path.join(staging, 'plugins'));
        fs.writeFileSync(path.join(staging, 'plugins', 'bgutil.zip'), plugin);
        // Dependency install scripts do not receive the bot's credentials.
        const env = { PATH: process.env.PATH, HOME: staging, USERPROFILE: staging, npm_config_cache: path.join(BASE, '.npm-provider-cache') };
        for (const name of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
        await run([process.env.npm_execpath, 'ci', '--include=dev', '--no-audit', '--no-fund'], serverHome(staging), env);
        await run([path.join(serverHome(staging), 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'], serverHome(staging), env);
        fs.writeFileSync(path.join(staging, 'ready'), `${SOURCE_HASH}:${PLUGIN_HASH}`);
        if (!ready(staging)) throw new Error('Provider installation is incomplete');
        clean(ROOT);
        fs.renameSync(staging, ROOT);
        console.log(`[YouTube] Token provider ${VERSION} installed.`);
    } finally { clean(staging); }
}

module.exports = { providerArgs, ready, verifiedDownload, setup };
if (require.main === module) setup().catch(error => { console.error(`[YouTube] ${error.message}`); process.exitCode = 1; });
