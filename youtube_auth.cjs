'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Railway supplies this private variable at runtime. Never write it into the image/repository.
function normalizeCookies(value, now = Date.now()) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) {
        throw new Error('YOUTUBE_COOKIES must be a YouTube-only Netscape cookie export under 256 KB.');
    }
    const lines = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split('\n');
    if (!/^# (?:Netscape )?HTTP Cookie File$/.test(lines[0])) {
        throw new Error('YOUTUBE_COOKIES must contain a Netscape cookie export, not JSON.');
    }
    const rows = [];
    let authenticated = false;
    for (const line of lines.slice(1)) {
        if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
        const fields = line.split('\t');
        const domain = fields[0].replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
        if (fields.length !== 7 || !/^(?:[a-z0-9-]+\.)*youtube\.com$/.test(domain) ||
            !/^(TRUE|FALSE)$/.test(fields[1]) || !fields[2].startsWith('/') ||
            !/^(TRUE|FALSE)$/.test(fields[3]) || !/^\d+$/.test(fields[4]) ||
            !fields[5] || /[\x00-\x08\x0b-\x1f\x7f]/.test(line)) {
            throw new Error('YOUTUBE_COOKIES contains an invalid row or cookies from another website. Export only youtube.com.');
        }
        if (/^(SAPISID|__Secure-[13]PAPISID)$/.test(fields[5]) && fields[6] &&
            (fields[4] === '0' || Number(fields[4]) * 1000 > now)) authenticated = true;
        rows.push(line);
    }
    if (!authenticated) throw new Error('YOUTUBE_COOKIES has no unexpired YouTube login cookie. Export a signed-in session.');
    return '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n';
}

function createCookieFile(value, parent = os.tmpdir()) {
    const contents = normalizeCookies(value);
    const directory = fs.mkdtempSync(path.join(parent, 'bebot-youtube-session-'));
    const file = path.join(directory, 'cookies.txt');
    const cleanup = () => {
        // These are the exact paths created by this call; never follow a configured path for deletion.
        fs.rmSync(file, { force: true });
        fs.rmdirSync(directory);
    };
    try {
        fs.chmodSync(directory, 0o700);
        fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
        return { file, cleanup };
    } catch (error) {
        try { cleanup(); } catch {}
        throw new Error('Could not prepare the private YouTube cookie file.');
    }
}

let configured;
function configuredCookies(env = process.env) {
    if (env.COOKIES_FILE?.trim()) return env.COOKIES_FILE.trim();
    if (!env.YOUTUBE_COOKIES?.trim()) return '';
    if (!configured) {
        configured = createCookieFile(env.YOUTUBE_COOKIES);
        process.once('exit', () => { try { configured.cleanup(); } catch {} });
        console.log('[YouTube] Private cookie file configured; authenticated access still requires a playback check.');
    }
    return configured.file;
}

module.exports = { normalizeCookies, createCookieFile, configuredCookies };
