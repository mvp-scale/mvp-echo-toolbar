/**
 * Run at most one instance of an async function at a time.
 *
 * WHY THIS IS ITS OWN THING, rather than a boolean at each call site: an
 * `await` between a check and the state that check reads is not a mutex, and
 * this codebase has now been bitten by that three separate times —
 * concurrent model downloads racing a `.part` file, 61 orchestrator inits in
 * 50 seconds, and (2026-08-17, on Windows) hundreds of orchestrator inits in a
 * few milliseconds.
 *
 * That last one is instructive. The guard was:
 *
 *     if (orchestrator.isReady() || orchestrator.isLoading()) return;
 *     ...three awaits...
 *     await orchestrator.initialize()      // <- isLoading() finally becomes true
 *
 * Every `engine:state` broadcast landing inside those three awaits passed the
 * guard, because none of them had yet caused `loading` to flip. Adding the
 * model-store lookup lengthened that window and turned a two-attempt race into
 * a storm. The bound has to live at the resource and it has to be set
 * SYNCHRONOUSLY, before anything can yield.
 *
 * Callers that arrive while a run is in flight are DROPPED, not queued: every
 * caller here is asking for the same idempotent outcome ("make the model
 * ready"), so the in-flight run already satisfies them. They resolve rather
 * than reject, because they are fire-and-forget IPC handlers and a rejection
 * nobody awaits is an unhandled rejection.
 */
export function singleFlight<A extends unknown[]>(
  fn: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  let inFlight = false;

  return async (...args: A) => {
    if (inFlight) return;
    // Set BEFORE any await — including before fn is called, so a synchronous
    // throw inside fn cannot leave the flag stuck on.
    inFlight = true;
    try {
      await fn(...args);
    } finally {
      // Cleared on BOTH paths. Holding the lock after a failure would make one
      // transient error permanent for the life of the process, which is the
      // same reason model-store.js clears its in-flight map in a finally.
      inFlight = false;
    }
  };
}
