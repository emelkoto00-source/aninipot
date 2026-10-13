import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PermissionFlagsBits, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { createNowPlayingAnnouncer, buildNowPlayingEmbed, buildRequestEmbed } from './music_embeds.js';
const require = createRequire(import.meta.url);

export function spotifyUri(input) {
  const text = String(input || '').trim();
  if (/^spotify:(track|album|playlist):[A-Za-z0-9]{22}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/);
    return match ? `spotify:${match[1]}:${match[2]}` : null;
  } catch { return null; }
}

export function spotifySong(item, requesterId) {
  const info = item?.decorations || {};
  const artists = (info.creators || []).map(x => x.entity?.decorations?.identity?.name).filter(Boolean);
  return { id: item?.uri, source: 'spotify', name: `${info.identity?.name || 'Spotify track'}${artists.length ? ` — ${artists.join(', ')}` : ''}`,
    url: /^spotify:track:[A-Za-z0-9]{22}$/.test(item?.uri) ? `https://open.spotify.com/track/${item.uri.split(':')[2]}` : undefined,
    duration: Number(info.playback?.duration_ms || 0) / 1000,
    thumbnail: info.visual_identity?.cover?.find(x => x.size === 'default')?.url || info.visual_identity?.cover?.[0]?.url,
    metadata: { requesterId } };
}

export function spotifyPosition(state, now = Date.now()) {
  const anchor = state?.position || {};
  const elapsed = state?.status === 'playing' && Number.isFinite(anchor.timestamp_ms)
    ? Math.max(0, now - anchor.timestamp_ms) * Math.max(0, Number(anchor.speed) || 0) : 0;
  return Math.max(0, (Number(anchor.position_ms) || 0) + elapsed) / 1000;
}

// Each command uses a separate local connection: Soloist has no request IDs.
export class SoloistControl extends EventEmitter {
  constructor(url, WebSocketImpl = WebSocket) { super(); this.url = url; this.WebSocket = WebSocketImpl; }
  request(command, fields = {}) {
    const expected = { get_state: 'playback_state', get_auth_state: 'auth_state', get_queue: 'queue_changed' }[command];
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocket(this.url);
      let sent = false, settled = false;
      const finish = (err, value) => {
        if (settled) return; settled = true; clearTimeout(timer); ws.close(); err ? reject(err) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Spotify control timed out.')), 10_000);
      // The initial auth snapshot is the protocol handshake. Send only after it,
      // and ignore the initial playback snapshot for control-command acknowledgements.
      ws.onmessage = ({ data }) => {
        let event; try { event = JSON.parse(String(data)); } catch { return; }
        if (!sent && event.type === 'auth_state') {
          if (command === 'get_auth_state') return finish(null, event);
          if (!event.logged_in) return finish(new Error('Spotify needs pairing.'));
          sent = true; ws.send(JSON.stringify({ type: 'command', command, ...fields })); return;
        }
        if (!sent) return;
        if (event.type === 'error') return finish(new Error('Spotify rejected the command.'));
        if (expected ? event.type === expected : event.type === 'command_result' && event.command === command) finish(null, event);
      };
      ws.onerror = () => finish(new Error('Spotify client is unavailable.'));
      ws.onclose = () => { if (!settled) finish(new Error('Spotify connection closed.')); };
    });
  }
  watch(callback, failed) {
    const ws = new this.WebSocket(this.url);
    let closed = false;
    ws.onmessage = ({ data }) => { try { callback(JSON.parse(String(data))); } catch { /* malformed event */ } };
    const stop = () => { if (!closed) { closed = true; failed(); } };
    ws.onerror = stop; ws.onclose = stop;
    return () => { closed = true; ws.close(); };
  }
}

export function createSpotifyManager(client, { runtimeFactory, voiceApi, spawnImpl = spawn } = {}) {
  let active = null, starting = null, runtime = null;
  const announcements = createNowPlayingAnnouncer();
  const view = session => session.closed ? null : ({ paused: session.state?.status === 'paused',
    buffering: session.state?.status === 'buffering', currentTime: spotifyPosition(session.state) });
  const announce = session => announcements.start(session.guildId, session.textChannel, session.song, () => view(session));
  const voice = () => voiceApi || require('@discordjs/voice');
  const ensureRuntime = async () => runtime ||= await (runtimeFactory ? runtimeFactory() : require('./spotify_runtime.cjs').start());
  const enabled = () => Boolean(runtimeFactory || process.env.BEBOT_SPOTIFY === '1');
  const has = id => active?.guildId === id;
  const reply = (interaction, content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  const isManager = i => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  async function end(session = active) {
    if (!session || session.closed) return;
    announcements.stop(session.guildId);
    session.closed = true;
    clearInterval(session.poll); clearTimeout(session.idle);
    for (const cleanup of [() => session.unwatch?.(), () => session.audio?.kill(), () => session.player?.stop(), () => session.connection?.destroy()]) {
      try { cleanup(); } catch { /* already closed by Discord */ }
    }
    await runtime?.control.request('pause').catch(() => {});
    if (active === session) active = null;
  }
  async function fail(session, reason = 'UNKNOWN') {
    if (session.closed) return;
    // Fixed reason codes only: never log credentials, session data, or raw errors.
    console.error(`[Spotify] Playback disconnected: ${reason}`);
    announcements.stop(session.guildId, '⚠ Playback ended');
    await end(session);
    session.textChannel?.send({ content: '❌ Spotify playback disconnected. Try `/play` again.', allowedMentions: { parse: [] } }).catch(() => {});
  }
  async function startPending(session) {
    const next = session.pending.shift();
    if (!next || session.closed) return false;
    announcements.stop(session.guildId, '✓ Finished');
    try {
      await runtime.control.request('play', { uri: next.uri });
      const deadline = Date.now() + 15000;
      while (!session.closed && Date.now() < deadline) {
        const state = await runtime.control.request('get_state');
        if (session.closed) return false;
        const matches = next.uri.startsWith('spotify:track:') ? state.item?.uri === next.uri : state.context?.uri === next.uri;
        if (matches && state.status === 'playing') {
          session.context = next.uri; session.requesterId = next.requesterId;
          session.state = state; session.lastUri = state.item?.uri;
          session.song = spotifySong(state.item, next.requesterId);
          session.upcoming = [];
          announce(session);
          return true;
        }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!session.closed) throw Error('Queued context did not start');
    } catch {
      if (!session.closed) await session.textChannel?.send({ content: '⚠ A queued Spotify request could not start. Check that its link is available to this Spotify account.', allowedMentions: { parse: [] } }).catch(() => {});
    }
    return false;
  }
  async function update(session) {
    if (session.closed || session.updating) return;
    session.updating = true;
    try {
      const state = await runtime.control.request('get_state');
      if (session.closed) return;
      session.state = state;
      if (!state.is_active) return fail(session, 'DEVICE_INACTIVE');
      const changed = state.item?.uri && state.item.uri !== session.lastUri;
      // Queue entries distinguish playlist context from recommendations. Never switch
      // just because a duration timer expires or the upcoming page is incomplete.
      const nextSource = session.upcoming?.find(x => x.item?.uri === state.item?.uri)?.source;
      if (session.pending.length && (state.status === 'idle' || (changed && nextSource === 'autoplay'))) {
        await startPending(session);
        return;
      }
      if (state.status === 'playing' && changed) {
        // Do not broadcast an unrelated context selected from the owner's Spotify app.
        if (state.context?.uri !== session.context && !session.queued.has(state.item.uri)) return end(session);
        const requester = session.queued.get(state.item.uri) || session.requesterId;
        session.queued.delete(state.item.uri);
        session.lastUri = state.item.uri;
        session.song = spotifySong(state.item, requester);
        announce(session);
      }
      if (session.pending.length) {
        try { const q = await runtime.control.request('get_queue', { limit: 0 }); session.upcoming = q.upcoming || []; }
        catch { /* keep prior boundary evidence; queue lookup must not stop audio */ }
      }
      if (state.status === 'idle') {
        announcements.stop(session.guildId, '✓ Finished');
        if (!session.keepAlive) await end(session);
      }
    } catch { if (!session.closed) await fail(session, 'STATE_QUERY_FAILED'); }
    finally { session.updating = false; }
  }

  async function play(interaction, { legacyBusy, releaseLegacy } = {}) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Use `/play` in your server.', flags: 64 });
    await interaction.deferReply();
    const uri = spotifyUri(interaction.options.getString('query', true));
    if (!uri) return reply(interaction, 'Use a Spotify track, album, or playlist link.');
    if (!enabled()) return reply(interaction, 'Spotify playback has not been configured yet.');
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const channel = member?.voice?.channel;
    if (!channel) return reply(interaction, '🎧 Join a voice channel first.');
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const permissions = me && channel.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) return reply(interaction, 'bebot needs **Connect** and **Speak** permissions.');
    if (starting || active?.closed) return reply(interaction, 'Spotify is starting or stopping. Please try again shortly.');
    if (active && (active.guildId !== interaction.guildId || active.voiceId !== channel.id)) return reply(interaction, 'Spotify is already active in another voice channel.');
    if (legacyBusy?.()) return reply(interaction, 'Use `/stop` before switching the current queue to Spotify.');
    if (active) {
      const session = active;
      try {
        const add = session.enqueueTail.catch(() => {}).then(async () => {
          if (session.closed) throw Error('Session stopped');
          if (!uri.startsWith('spotify:track:') || session.pending.length) {
            if (session.pending.length >= 50) throw Error('Queue full');
            // Snapshot before accepting so a context-to-autoplay transition is observable.
            const q = await runtime.control.request('get_queue', { limit: 0 });
            if (session.closed) throw Error('Session stopped');
            session.upcoming = q.upcoming || [];
            session.pending.push({ uri, requesterId: interaction.user.id });
            return `✓ Queued Spotify ${uri.split(':')[1]} · ${session.pending.length} waiting. It will play after the current playlist and earlier requests.`;
          }
          await runtime.control.request('add_to_queue', { uri });
          if (session.closed) throw Error('Session stopped');
          session.queued.set(uri, interaction.user.id);
          return '✓ Added the Spotify track to the queue.';
        });
        session.enqueueTail = add;
        return reply(interaction, await add);
      } catch { return reply(interaction, '❌ Could not queue that Spotify request. Please try again.'); }
    }
    const session = { guildId: interaction.guildId, voiceId: channel.id, textChannel: interaction.channel,
      requesterId: interaction.user.id, context: uri, queued: new Map(), pending: [], upcoming: [], enqueueTail: Promise.resolve(), closed: false, keepAlive: false };
    starting = session; active = session;
    try {
      const rt = await ensureRuntime();
      if (session.closed) throw new Error('Cancelled');
      if (!(await rt.control.request('get_auth_state')).logged_in) throw new Error('Pairing required');
      await releaseLegacy?.();
      const api = voice();
      session.connection = api.joinVoiceChannel({ channelId: channel.id, guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
      await api.entersState(session.connection, api.VoiceConnectionStatus.Ready, 20_000);
      if (session.closed) throw new Error('Cancelled');
      session.player = api.createAudioPlayer({ behaviors: { noSubscriber: api.NoSubscriberBehavior.Pause } });
      // Discord consumes a frame every 20 ms. PulseAudio's default capture buffer
      // arrives in large bursts and can starve the player between those bursts.
      session.audio = spawnImpl(rt.parec, ['--device=spotify_bebot.monitor', '--format=s16le', '--rate=48000', '--channels=2', '--raw', '--latency-msec=20', '--process-time-msec=20'],
        { env: rt.env, stdio: ['ignore', 'pipe', 'ignore'] });
      session.audio.on('error', () => void fail(session, 'AUDIO_CAPTURE_ERROR'));
      session.audio.on('exit', () => { if (!session.closed) void fail(session, 'AUDIO_CAPTURE_EXIT'); });
      session.player.on('error', () => void fail(session, 'DISCORD_AUDIO_ERROR'));
      session.connection.on('stateChange', (_old, next) => {
        if (['disconnected', 'destroyed'].includes(next.status) && !session.closed) void fail(session, 'DISCORD_VOICE_DISCONNECTED');
      });
      session.connection.subscribe(session.player);
      session.player.play(api.createAudioResource(session.audio.stdout, { inputType: api.StreamType.Raw }));
      await rt.control.request('set_repeat_track', { enabled: false });
      await rt.control.request('set_repeat_context', { enabled: false });
      await rt.control.request('set_shuffle', { enabled: false });
      await rt.control.request('set_volume', { volume: 80 });
      if (session.closed) throw new Error('Cancelled');
      await rt.control.request('play', { uri });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !session.closed) {
        session.state = await rt.control.request('get_state');
        if (session.state.status === 'playing' && session.state.is_active &&
            (uri.startsWith('spotify:track:') ? session.state.item?.uri === uri : session.state.context?.uri === uri)) break;
        await new Promise(r => setTimeout(r, 300));
      }
      if (session.closed || session.state?.status !== 'playing' ||
          (uri.startsWith('spotify:track:') ? session.state.item?.uri !== uri : session.state.context?.uri !== uri)) throw new Error('Playback did not start');
      session.song = spotifySong(session.state.item, interaction.user.id);
      session.lastUri = session.state.item.uri;
      session.unwatch = rt.control.watch(event => {
        if (event.type === 'position_sync' && session.state) session.state = { ...session.state, position: event.position };
        if (['track_changed', 'playback_changed', 'device_changed'].includes(event.type)) void update(session);
      }, () => void fail(session, 'EVENT_CONNECTION_CLOSED'));
      session.poll = setInterval(() => void update(session), 5_000); session.poll.unref?.();
      await interaction.editReply({ embeds: [buildRequestEmbed(session.song)], allowedMentions: { parse: [] } });
      announce(session);
    } catch {
      await end(session);
      await reply(interaction, '❌ Spotify playback could not start. Check the bot’s Spotify setup.');
    } finally { if (starting === session) starting = null; }
  }

  async function control(interaction) {
    await interaction.deferReply(interaction.commandName === 'nowplaying' ? {} : { flags: 64 });
    const session = active;
    if (!session || session.guildId !== interaction.guildId) return reply(interaction, 'No Spotify session is active.');
    const command = interaction.commandName;
    const loopMode = command === 'loop' ? interaction.options.getString('mode') || 'status' : null;
    if (!['queue', 'nowplaying'].includes(command) && loopMode !== 'status') {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (member?.voice?.channelId !== session.voiceId && !isManager(interaction)) return reply(interaction, 'Join my voice channel or have **Manage Server** permission.');
    }
    try {
      if (['stop', 'leave'].includes(command)) { await end(session); return reply(interaction, '⏹️ Stopped Spotify and disconnected.'); }
      if (starting === session) return reply(interaction, 'Spotify is still loading. Use `/stop` to cancel.');
      if (command === 'loop') {
        const modes = { off: 'off', song: 'track', queue: 'context' };
        if (loopMode !== 'status' && !(loopMode in modes)) return reply(interaction, 'Choose Song, Queue / Playlist, Off, or Status.');
        // Serialize the two repeat switches so simultaneous commands cannot mix modes.
        const change = (session.loopTail || Promise.resolve()).catch(() => {}).then(async () => {
          if (session.closed) throw Error('Session stopped');
          if (loopMode !== 'status') {
            const switches = loopMode === 'song'
              ? [['set_repeat_context', false], ['set_repeat_track', true]]
              : [['set_repeat_track', false], ['set_repeat_context', loopMode === 'queue']];
            for (const [command, enabled] of switches) {
              if (session.closed) throw Error('Session stopped');
              await runtime.control.request(command, { enabled });
            }
          }
          const deadline = Date.now() + 3000;
          let state;
          do {
            if (session.closed) throw Error('Session stopped');
            state = await runtime.control.request('get_state');
            if (loopMode === 'status' || state.options?.repeat === modes[loopMode]) break;
            await new Promise(r => setTimeout(r, 150));
          } while (Date.now() < deadline);
          if (session.closed) throw Error('Session stopped');
          if (loopMode !== 'status' && state.options?.repeat !== modes[loopMode]) return 'Spotify has not confirmed the loop change yet. Check `/loop status`.';
          const label = { off: 'Off', track: 'Song', context: 'Current playlist / album' }[state.options?.repeat];
          if (!label) return 'Spotify loop status is unavailable. Try again shortly.';
          return `🔁 Loop: **${label}**.${state.options.repeat === 'context' ? ' Later playlists wait until you turn loop off.' : ''}`;
        });
        session.loopTail = change;
        return reply(interaction, await change);
      }
      if (command === 'pause' || command === 'resume') {
        await runtime.control.request(command === 'pause' ? 'pause' : 'play');
        await update(session);
        return reply(interaction, command === 'pause' ? '⏸️ Paused playback.' : '▶️ Resumed playback.');
      }
      if (command === 'skip' || command === 'next') {
        const previous = session.lastUri;
        await runtime.control.request('skip_next');
        // A track event may already have installed the next card before the acknowledgement.
        if (session.lastUri === previous) announcements.stop(session.guildId, '⏭ Skipped');
        await update(session);
        return reply(interaction, '⏭️ Skipped to the next Spotify track.');
      }
      if (command === 'volume') { const volume = Math.max(0, Math.min(100, interaction.options.getInteger('level', true))); await runtime.control.request('set_volume', { volume }); return reply(interaction, `🔊 Volume set to **${volume}%**.`); }
      if (command === 'nowplaying') {
        const s = await runtime.control.request('get_state');
        if (!s.item?.uri || s.status === 'idle') return reply(interaction, 'Nothing is playing right now.');
        return interaction.editReply({ embeds: [buildNowPlayingEmbed({ paused: s.status === 'paused', buffering: s.status === 'buffering', currentTime: spotifyPosition(s) }, spotifySong(s.item, session.song?.metadata?.requesterId))], allowedMentions: { parse: [] } });
      }
      if (command === 'queue') {
        const q = await runtime.control.request('get_queue', { limit: 0 });
        const upcoming = q.upcoming || [];
        const entries = [session.state.item, ...upcoming.filter(x => !session.pending.length || x.source !== 'autoplay').map(x => x.item),
          ...session.pending.map(x => ({ uri: x.uri, decorations: { identity: { name: `Queued Spotify ${x.uri.split(':')[1]} · https://open.spotify.com/${x.uri.split(':').slice(1).join('/')}` } } }))].filter(Boolean);
        const page = interaction.options.getInteger('page') || 1, pages = Math.max(1, Math.ceil(entries.length / 8));
        if (page > pages) return reply(interaction, `Choose a page from 1 to ${pages}.`);
        const lines = entries.slice((page - 1) * 8, page * 8).map((item, i) => `${(page - 1) * 8 + i + 1}. ${escapeMarkdown(spotifySong(item).name.slice(0, 100))}`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xED91CF).setTitle('♫ Spotify Queue').setDescription(lines.join('\n') || 'Empty').setFooter({ text: `Page ${page}/${pages} · Spotify loads more tracks as playback continues` })] });
      }
      if (command === '247') {
        const mode = interaction.options.getString('mode', true);
        if (mode !== 'status') session.keepAlive = mode === 'on';
        return reply(interaction, `24/7 mode: **${session.keepAlive ? 'ON' : 'OFF'}**.`);
      }
      if (command === 'autoplay') return reply(interaction, 'Spotify manages recommendations for this session. `/autoplay` controls YouTube queues.');
      return reply(interaction, 'That control is unavailable for Spotify.');
    } catch { return reply(interaction, '❌ The Spotify control failed. Please try again.'); }
  }
  function getListeningQueue(guildId) {
    const session = active;
    if (!session || session.guildId !== guildId || session.closed || starting === session ||
        session.state?.status !== 'playing' || !session.state.is_active ||
        session.player?.state?.status !== 'playing' || session.connection?.state?.status !== 'ready') return null;
    // Read the latest item so each Spotify recommendation earns its own credit.
    return { playing: true, paused: false, songs: [spotifySong(session.state.item, session.requesterId)],
      voiceChannel: client.guilds.cache.get(guildId)?.channels.cache.get(session.voiceId) };
  }
  return { has, play, control, getListeningQueue, close: async () => { await end(); await runtime?.close(); } };
}
