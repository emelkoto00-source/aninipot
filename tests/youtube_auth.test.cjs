'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { normalizeCookies, createCookieFile, configuredCookies } = require('../youtube_auth.cjs');
const header = '# Netscape HTTP Cookie File\n';
const row = '.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-test-value';

test('only YouTube Netscape rows are accepted without disclosing values in errors', () => {
    assert.equal(normalizeCookies('\uFEFF' + header + row.replace(/\n/g, '\r\n')), header + row + '\n');
    assert.equal(normalizeCookies(header + '#HttpOnly_' + row), header + '#HttpOnly_' + row + '\n');
    for (const bad of ['{"secret":"synthetic-test-value"}', header + row.replace('.youtube.com', '.google.com'),
        header + row.replace('.youtube.com', '.youtube.com.evil.test'), header + row + '\textra',
        header + row.replace('\t0\t', '\t1\t'), header + row.replace('SAPISID', 'PREF')]) {
        assert.throws(() => normalizeCookies(bad), error => !error.message.includes('synthetic-test-value'));
    }
});

test('private session file normalizes line endings, cleans up, and respects existing file configuration', () => {
    assert.equal(configuredCookies({}), '');
    assert.equal(configuredCookies({ COOKIES_FILE: '/already/configured', YOUTUBE_COOKIES: 'ignored' }), '/already/configured');
    const session = createCookieFile((header + row).replace(/\n/g, '\r\n'));
    try {
        assert.equal(fs.readFileSync(session.file, 'utf8'), header + row + '\n');
        if (process.platform !== 'win32') assert.equal(fs.statSync(session.file).mode & 0o777, 0o600);
    } finally { session.cleanup(); }
    assert.equal(fs.existsSync(session.file), false);
});
