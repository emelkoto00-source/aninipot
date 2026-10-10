// Per-guild command serialization plus an immediately invalidatable session.
export class MusicSessions {
  constructor({ maxPending = 10 } = {}) {
    this.states = new Map();
    this.maxPending = maxPending;
    this.closed = false;
  }
  state(id) {
    let state = this.states.get(id);
    if (!state) {
      state = { controller: new AbortController(), chain: Promise.resolve(), pending: 0, voiceId: null };
      this.states.set(id, state);
    }
    return state;
  }
  reserve(id, voiceId) {
    if (this.closed) throw new Error('The music service is shutting down.');
    const state = this.state(id);
    if (state.pending >= this.maxPending) throw new Error('Too many music requests are waiting. Please try again shortly.');
    if (state.voiceId && state.voiceId !== voiceId) throw new Error('Music is active or loading in another voice channel.');
    state.voiceId = voiceId;
    return state.controller.signal;
  }
  run(id, task) {
    const state = this.state(id);
    state.pending++;
    const run = state.chain.then(task).finally(() => { state.pending--; });
    state.chain = run.catch(() => {});
    return run;
  }
  cancel(id) {
    const state = this.state(id);
    state.controller.abort();
    state.controller = new AbortController();
  }
  release(id) {
    const state = this.states.get(id);
    if (state && state.pending === 0) state.voiceId = null;
  }
  async close() {
    this.closed = true;
    for (const state of this.states.values()) state.controller.abort();
    await Promise.all([...this.states.values()].map(s => s.chain));
  }
}
