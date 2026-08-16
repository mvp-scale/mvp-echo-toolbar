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
    /**
     * 'error' and 'messageerror' are tracked separately because they are the
     * only way a worker whose SCRIPT never loaded can report anything — it can
     * never send a 'message', so a test that can only emit messages cannot
     * reproduce that failure at all.
     */
    this.errorListeners = [];
    this.messageErrorListeners = [];
    this.posted = [];
    this.transfers = [];
    this.terminated = false;
    /** Set by a test to auto-reply to a posted message. */
    this.onPost = null;
  }

  addEventListener(type, fn) {
    if (type === 'message') this.listeners.push(fn);
    else if (type === 'error') this.errorListeners.push(fn);
    else if (type === 'messageerror') this.messageErrorListeners.push(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'message') this.listeners = this.listeners.filter((l) => l !== fn);
    else if (type === 'error') this.errorListeners = this.errorListeners.filter((l) => l !== fn);
    else if (type === 'messageerror') this.messageErrorListeners = this.messageErrorListeners.filter((l) => l !== fn);
  }

  /**
   * Deliver a worker `error` event — what a real Worker fires when its module
   * script is blocked (COEP), missing, or fails to parse. Note that for a
   * blocked cross-origin load the browser deliberately withholds detail, so
   * `message` is often empty; tests should cover that case, not just the
   * friendly one.
   */
  emitError({ message = '', filename = '', lineno = 0 } = {}) {
    for (const fn of [...this.errorListeners]) fn({ type: 'error', message, filename, lineno });
  }

  /** Deliver a `messageerror` event — an incoming message that failed structured clone. */
  emitMessageError() {
    for (const fn of [...this.messageErrorListeners]) fn({ type: 'messageerror' });
  }

  postMessage(msg, transfer) {
    this.posted.push(msg);
    this.transfers.push(transfer ?? []);
    // Model transfer semantics: a transferred ArrayBuffer is detached in the
    // sender. Tests assert on this to prove the PCM is moved, not cloned.
    for (const t of transfer ?? []) {
      if (typeof structuredClone === 'function' && t instanceof ArrayBuffer) {
        try { structuredClone(t, { transfer: [t] }); } catch { /* already detached */ }
      }
    }
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
    this.emitForced(data);
  }

  /**
   * Deliver a message even if terminate() has been called.
   *
   * Needed to test the orchestrator's *own* supersession guard. If a test
   * relies on `emit()`'s termination check to keep a stale message out, the
   * fake is doing the guard's job and the test passes even with the production
   * guard deleted — which is exactly the vacuous-test trap. A real Worker can
   * also have a message already dispatched before terminate() takes effect, so
   * this is not a purely hypothetical ordering.
   */
  emitForced(data) {
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
