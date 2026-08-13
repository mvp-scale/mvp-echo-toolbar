/**
 * Test double for the DOM `Worker` the InferenceOrchestrator spawns.
 *
 * Implements only the surface the orchestrator uses (addEventListener /
 * removeEventListener / postMessage / terminate) plus `emit()` so a test can
 * drive worker->main messages, and `terminated` so a test can assert teardown.
 */
export class FakeWorker {
  constructor() {
    this.listeners = [];
    this.posted = [];
    this.terminated = false;
    /** Set by a test to auto-reply to a posted message. */
    this.onPost = null;
  }

  addEventListener(type, fn) {
    if (type === 'message') this.listeners.push(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'message') this.listeners = this.listeners.filter((l) => l !== fn);
  }

  postMessage(msg) {
    this.posted.push(msg);
    if (this.onPost) this.onPost(msg, this);
  }

  terminate() {
    this.terminated = true;
  }

  /** Deliver a worker->main message to every registered listener. */
  emit(data) {
    // A terminated worker cannot deliver messages; modelling that faithfully
    // matters, because the bug under test is a promise left pending forever
    // precisely because no further message can arrive.
    if (this.terminated) return;
    for (const fn of [...this.listeners]) fn({ data });
  }
}

/** Minimal browser globals so `prepareModelCache()` runs under Node. */
export function stubBrowserStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  if (!globalThis.navigator) globalThis.navigator = {};
  // No `storage.persist` -> requestPersistence() returns false, no IndexedDB touched.
  return store;
}
