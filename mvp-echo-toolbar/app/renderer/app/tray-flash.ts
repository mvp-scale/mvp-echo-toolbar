/**
 * A tray state change with a guarded automatic revert.
 *
 * CaptureApp had six copies of `setTimeout(() => updateTrayState('ready'), 3000)`
 * with no guard between them. A revert scheduled by one recording fires three
 * seconds later no matter what has happened since, so it overwrites the tray
 * state of a NEWER recording — showing "ready" mid-recording, or clearing an
 * error before the user has seen it.
 *
 * Main already had this right: tray-manager.js clears any pending timeout on
 * every setState. The renderer re-created the anti-pattern main had deleted.
 *
 * Two guards, because one is not enough:
 *   - only ONE revert may be pending; scheduling another cancels the first
 *   - a revert checks it still belongs to the current generation before firing,
 *     so work started after it was scheduled is never stomped
 *
 * Timer functions are injectable purely so this is testable without waiting.
 */

export type TrayState = string;

export interface TrayFlasherOptions {
  setState: (state: TrayState) => void;
  /** Monotonic counter identifying the current unit of work. */
  generation?: () => number;
  // Deliberately loose: the handle type differs between Node, the DOM and the
  // fake used in tests, and this module only ever passes it straight back.
  setTimeout?: (fn: () => void, ms: number) => any;
  clearTimeout?: (id: any) => void;
}

export interface TrayFlasher {
  (state: TrayState, opts?: { revertTo?: TrayState; afterMs?: number }): void;
  cancel: () => void;
}

export function createTrayFlasher(options: TrayFlasherOptions): TrayFlasher {
  const {
    setState,
    generation = () => 0,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = options;

  let pending: any = null;

  const cancel = () => {
    if (pending !== null) {
      unschedule(pending);
      pending = null;
    }
  };

  const flash: TrayFlasher = (state, { revertTo = 'ready', afterMs = 3000 } = {}) => {
    cancel();
    setState(state);

    const scheduledAt = generation();
    pending = schedule(() => {
      pending = null;
      // The work that scheduled this revert has been superseded; whatever is on
      // the tray now belongs to something newer.
      if (generation() !== scheduledAt) return;
      setState(revertTo);
    }, afterMs);
  };

  flash.cancel = cancel;
  return flash;
}
