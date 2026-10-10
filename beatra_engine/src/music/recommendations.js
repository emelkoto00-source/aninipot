'use strict';

// Recommendation selection only. Explicit /play requests and audio retrieval
// never pass through this filter. Memory survives queue changes until restart.
function titleKey(song) {
    return String(song?.name || '').slice(0, 500).normalize('NFKD')
        .replace(/\p{M}/gu, '').toLowerCase()
        .replace(/\b(?:official(?:\s+music)?\s+(?:video|audio)|official|music\s+video|lyric(?:s|\s+video)?|audio|visuali[sz]er|hd|hq|4k|1080p)\b/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');
}
function identity(song) {
    return { id: song?.id ? `${song.source || 'youtube'}:${song.id}` : '', title: titleKey(song) };
}
class RecentTracks {
    constructor({ limit = 50, maxGuilds = 100, random = Math.random } = {}) {
        this.limit = limit;
        this.maxGuilds = maxGuilds;
        this.random = random;
        this.guilds = new Map();
    }
    remember(guildId, song) {
        if (!guildId || !song) return;
        const key = identity(song);
        if (!key.id && !key.title) return;
        const records = (this.guilds.get(guildId) || []).filter(item =>
            !(key.id && key.id === item.id) && !(key.title && key.title === item.title));
        records.push(key);
        this.guilds.delete(guildId);
        this.guilds.set(guildId, records.slice(-this.limit));
        while (this.guilds.size > this.maxGuilds) this.guilds.delete(this.guilds.keys().next().value);
    }
    select(guildId, candidates, seed, queue) {
        const excluded = [...(this.guilds.get(guildId) || []), identity(seed), ...(queue?.songs || []).map(identity)];
        const ids = new Set(excluded.map(item => item.id).filter(Boolean));
        const titles = new Set(excluded.map(item => item.title).filter(Boolean));
        // DisTube retains IDs for the whole active queue, even beyond our recent window.
        const previousIds = new Set((queue?.previousSongs || []).map(song => song.id));
        const fresh = [];
        for (const song of candidates) {
            const key = identity(song);
            if (ids.has(key.id) || previousIds.has(song.id) || (key.title && titles.has(key.title))) continue;
            if (key.id) ids.add(key.id);
            if (key.title) titles.add(key.title);
            fresh.push(song);
        }
        // The engine selects the first returned item. Shuffle only fresh related
        // results; never weaken duplicate checks if the available pool is empty.
        for (let i = fresh.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
        }
        return fresh;
    }
}
module.exports = { RecentTracks, titleKey };
