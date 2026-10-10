import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { bounded } from './music_sources.js';
const require = createRequire(import.meta.url);
const diagnostic = require('./beatra_engine/src/core/diagnostics.js');

// Adapter for the audited DisTube 5.2.3 lifecycle. No library files are modified.
// An audio resource becoming Playing is evidence of local packet production, not audibility.
export function instrumentMusic(player, { sessions, relay, report = diagnostic.event, notice = () => {} }) {
  const attempts = new WeakMap();
  const active = new Map();
  const pending = new Map();
  const errors = new WeakMap();
  const listeners = new Map();
  const emit = (record, stage, outcome, extra = {}) => report('playback', {
    attemptId: record?.id, guild: diagnostic.guildTag(record?.guildId),
    source: record?.song?.source, stage, outcome, ...extra
  });
  function prepare(song, metadata = {}) {
    song.metadata = { ...song.metadata, ...metadata };
    const record = { id: randomUUID(), song, guildId: song.metadata.guildId, terminal: false, consumed: false };
    song.metadata = { ...song.metadata, attemptId: record.id };
    attempts.set(song, record);
    return record;
  }
  function finish(song, outcome, error) {
    const record = attempts.get(song);
    if (!record || record.terminal) return;
    const failure = error || relay.errorFor(song?.stream?.url);
    record.terminal = true;
    let result = failure ? 'failed' : outcome;
    if (song._bebotSignal?.aborted || record.cancelled) result = 'cancelled';
    emit(record, 'track_completion', result, { reason: failure ? diagnostic.classify(failure) : undefined,
      playedMs: record.resource?.playbackDuration || 0, expectedDurationMs: (song.duration || 0) * 1000 });
    if (active.get(record.guildId) === record) active.delete(record.guildId);
    if (result === 'failed') {
      errors.set(song, failure);
      if (!record.awaitingRequest) notice(record.guildId, `❌ This track could not finish playing. Reference: ${record.id.slice(0, 8)}`);
    }
    relay.discard?.(song?.stream?.url);
  }
  const attach = player.handler.attachStreamInfo.bind(player.handler);
  player.handler.attachStreamInfo = async song => {
    let record = attempts.get(song);
    if (!record || record.consumed) record = prepare(song);
    record.consumed = true;
    const controller = new AbortController();
    const session = song.metadata?.signal || sessions.state(record.guildId).controller.signal;
    song._bebotSignal = AbortSignal.any([session, controller.signal]);
    record.controller = controller;
    active.set(record.guildId, record);
    pending.set(record.guildId, record);
    const start = performance.now();
    emit(record, 'discord_voice', player.getQueue?.(record.guildId)?.voice?.connection?.state?.status || 'unknown');
    emit(record, 'stream_retrieval', 'started');
    try {
      song._bebotSignal.throwIfAborted();
      // A reused Song must not keep an old relay URL after cancellation or failure.
      if (song.stream?.url) delete song.stream.url;
      await attach(song);
      song._bebotSignal.throwIfAborted();
      emit(record, 'stream_retrieval', 'ready', { elapsedMs: Math.round(performance.now() - start) });
    } catch (error) {
      emit(record, 'stream_retrieval', song._bebotSignal.aborted ? 'cancelled' : 'failed', { reason: diagnostic.classify(error) });
      errors.set(song, error);
      throw error;
    } finally {
      if (pending.get(record.guildId) === record) pending.delete(record.guildId);
    }
  };
  player.on('initQueue', queue => {
    const voice = queue.voice;
    const original = voice.play.bind(voice);
    voice.play = async stream => {
      const song = queue.songs[0];
      const record = attempts.get(song);
      const signal = song?._bebotSignal;
      const spawn = stream.spawn.bind(stream);
      stream.spawn = () => {
        signal?.throwIfAborted(); // check again after DisTube's async encryption check
        emit(record, 'ffmpeg_decoding', 'spawn_requested');
        spawn();
        stream.process?.stdout?.once('data', chunk => emit(record, 'ffmpeg_decoding', 'bytes_observed', { receivedBytes: chunk.length }));
        stream.process?.once('close', (code, sig) => emit(record, 'ffmpeg_decoding', 'exited', { exitCode: code, signal: sig }));
      };
      try {
        signal?.throwIfAborted();
        if (record) record.resource = stream.audioResource;
        await original(stream);
      } catch (error) { stream.kill(); throw error; }
    };
    const audioState = (_old, next) => {
      const record = active.get(queue.id);
      if (!record || next.resource !== record.resource || next.status !== 'playing') return;
      if (record.voiceLogged) return;
      record.voiceLogged = true;
      emit(record, 'discord_voice', voice.connection?.state?.status === 'ready' ? 'resource_playing_voice_ready' : 'resource_playing_voice_not_ready');
    };
    const connectionState = (_old, next) => {
      const record = active.get(queue.id);
      if (record && ['ready', 'disconnected', 'destroyed'].includes(next.status)) emit(record, 'discord_voice', next.status);
    };
    voice.audioPlayer?.on('stateChange', audioState);
    voice.connection?.on('stateChange', connectionState);
    listeners.set(queue, () => {
      voice.audioPlayer?.off('stateChange', audioState);
      voice.connection?.off('stateChange', connectionState);
      voice.play = original;
    });
  });
  player.on('playSong', (queue, song) => emit(attempts.get(song), 'player_dispatch', 'accepted'));
  player.on('finishSong', (_queue, song) => finish(song, 'ended'));
  player.on('error', (error, queue, song) => {
    if (song) { errors.set(song, error); finish(song, 'failed', error); }
    else report('playback', { guild: diagnostic.guildTag(queue?.id), stage: 'engine', outcome: 'failed', reason: diagnostic.classify(error) });
  });
  player.on('deleteQueue', queue => {
    const record = active.get(queue.id);
    if (record) finish(record.song, 'queue_removed');
    listeners.get(queue)?.(); listeners.delete(queue);
  });
  player.on('disconnect', queue => { sessions.cancel(queue.id); });
  return {
    prepare, errors, pending,
    async resolve(query, options) {
      const id = randomUUID();
      const fields = { attemptId: id, guild: diagnostic.guildTag(options.metadata.guildId), stage: 'metadata_lookup' };
      report('playback', { ...fields, outcome: 'started' });
      try {
        const resolved = await bounded(() => player.handler.resolve(query, { ...options,
          metadata: { ...options.metadata, attemptId: id } }), options.metadata.signal);
        options.metadata.signal.throwIfAborted();
        const songs = resolved.songs || [resolved];
        for (const song of songs) {
          const record = prepare(song, options.metadata);
          record.awaitingRequest = true;
          // Keep lookup and first playback linked; subsequent playlist tracks get their own IDs.
          if (song === songs[0]) { record.id = id; song.metadata.attemptId = id; }
        }
        report('playback', { ...fields, outcome: 'resolved', count: songs.length });
        return resolved;
      } catch (error) {
        report('playback', { ...fields, outcome: options.metadata.signal.aborted ? 'cancelled' : 'failed', reason: diagnostic.classify(error) });
        throw error;
      }
    },
    cancelTrack(queue) { const record = active.get(queue.id); if (record) { finish(record.song, 'cancelled'); record.controller?.abort(); } },
    requestDone(result) { for (const song of result.songs || [result]) { const record = attempts.get(song); if (record) record.awaitingRequest = false; } },
    markCancelled(song) { const record = attempts.get(song); if (record) record.cancelled = true; return () => { if (record) record.cancelled = false; }; },
    cancelSong(song) { const record = attempts.get(song); if (record) { finish(song, 'cancelled'); record.controller?.abort(); } },
    close() { for (const clean of listeners.values()) clean(); listeners.clear(); }
  };
}
