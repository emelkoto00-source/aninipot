'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { providerArgs, ready, verifiedDownload } = require('../youtube_setup.cjs');

test('incomplete provider never adds broken extraction flags; configured opt-out works', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bebot-provider-test-'));
    try {
        assert.deepEqual(providerArgs({ root }), []);
        const server = path.join(root, 'bgutil-ytdlp-pot-provider-2.0.2', 'server');
        for (const dir of ['build', 'node_modules/canvas']) fs.mkdirSync(path.join(server, dir), { recursive: true });
        fs.mkdirSync(path.join(root, 'plugins'));
        fs.writeFileSync(path.join(server, 'build', 'generate_once.js'), '');
        fs.writeFileSync(path.join(server, 'node_modules', 'canvas', 'package.json'), '{}');
        fs.writeFileSync(path.join(root, 'plugins', 'bgutil.zip'), '');
        assert.equal(ready(root), false);
        fs.writeFileSync(path.join(root, 'ready'), 'df68ee6210e4960757bceae298927fb2ebd4d5cd9d390f9ff3a8287b0d2d1054:a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef');
        assert.equal(ready(root), true);
        const args = providerArgs({ root });
        assert.ok(args.includes('youtube:player_client=mweb'));
        assert.ok(args.includes(`youtubepot-bgutilscript:server_home=${server}`));
        const signedIn = providerArgs({ root, authenticated: true });
        assert.ok(signedIn.includes('--plugin-dirs'));
        assert.ok(!signedIn.some(arg => arg.includes('player_client=')));
        assert.deepEqual(providerArgs({ root, useProvider: false }), []);
        fs.unlinkSync(path.join(server, 'build', 'generate_once.js'));
        assert.deepEqual(providerArgs({ root }), []);
    } finally {
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('download rejects wrong content and HTTP failures before any code is installed', async () => {
    const originalFetch = global.fetch;
    const data = Buffer.from('verified test archive');
    const hash = createHash('sha256').update(data).digest('hex');
    try {
        global.fetch = async () => new Response(data);
        assert.deepEqual(await verifiedDownload('https://example.invalid/archive', hash), data);
        await assert.rejects(verifiedDownload('https://example.invalid/archive', '0'.repeat(64)), /checksum mismatch/);
        global.fetch = async () => new Response('not found', { status: 404 });
        await assert.rejects(verifiedDownload('https://example.invalid/archive', hash), /HTTP 404/);
    } finally { global.fetch = originalFetch; }
});
