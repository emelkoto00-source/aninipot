'use strict';

// Keep request IDs, stage, timing and numeric outcomes; never dump Song/HTTP/env objects.
const crypto = require('node:crypto');
const salt = crypto.randomBytes(16);
const allowed = new Set(['attemptId', 'guild', 'source', 'stage', 'outcome', 'reason',
    'elapsedMs', 'receivedBytes', 'playedMs', 'expectedDurationMs', 'exitCode', 'signal',
    'cancelled', 'node', 'distube', 'voice', 'ytDlp', 'ffmpeg', 'build', 'count']);

function redact(value) {
    let text = String(value?.message || value || 'Unknown error');
    for (const [key, secret] of Object.entries(process.env)) {
        if (!secret || !/(TOKEN|SECRET|PASSWORD|API_KEY|PROXY_URL|COOKIES)/i.test(key)) continue;
        text = text.split(secret).join('[redacted]');
        if (key === 'PROXY_URL') for (const item of secret.split(',')) {
            if (item.trim()) text = text.split(item.trim()).join('[redacted]');
        }
    }
    return text.replace(/(?:https?|socks5h?):\/\/[^\s"'<>]+/gi, '[URL]')
        .replace(/(?:authorization|proxy-authorization)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi, '[credential]')
        .replace(/(?:cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[credential]')
        .replace(/po_token\s*[:=]\s*[^\s,;]+/gi, '[credential]')
        .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
}

function classify(error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'CANCELLED';
    const text = String(error?.message || error || '');
    if (/drm|protected/i.test(text)) return 'PROTECTED_SOURCE';
    if (/preview|snipped/i.test(text)) return 'PREVIEW_ONLY';
    if (/sign in|not a bot|bot verification/i.test(text)) return 'SOURCE_CHALLENGE';
    if (/403|forbidden/i.test(text)) return 'HTTP_403';
    if (/429|rate.?limit/i.test(text)) return 'RATE_LIMITED';
    if (/timed? ?out|within \d+s/i.test(text)) return 'TIMEOUT';
    if (/no.related/i.test(error?.code || '') || /related/i.test(text)) return 'NO_RELATED';
    if (/voice|connect|encryption/i.test(text)) return 'VOICE_ERROR';
    if (/no audio|empty/i.test(text)) return 'NO_AUDIO';
    return 'PLAYBACK_ERROR';
}

function guildTag(id) {
    return id ? crypto.createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 12) : undefined;
}

function event(name, fields = {}) {
    const output = { time: new Date().toISOString(), event: String(name).replace(/[^a-z0-9_]/gi, '').slice(0, 60) };
    for (const [key, value] of Object.entries(fields)) {
        if (!allowed.has(key) || value === undefined || value === null) continue;
        if (typeof value === 'number') { if (Number.isFinite(value)) output[key] = value; }
        else if (typeof value === 'boolean') output[key] = value;
        else if (typeof value === 'string') output[key] = redact(value);
    }
    console.log(JSON.stringify(output));
}

module.exports = { redact, classify, guildTag, event };
