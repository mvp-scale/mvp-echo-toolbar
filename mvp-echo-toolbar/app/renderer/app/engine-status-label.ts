/**
 * Turn the engine record into something honest to display.
 *
 * StatusIndicator previously took no props and rendered a hardcoded green dot
 * and the literal "Ready". The one window a user opens to find out what is
 * wrong asserted that nothing was — including throughout the Electron 43
 * failure, where the worker was blocked, the orchestrator never became ready
 * and the hotkey was dead.
 *
 * Pure, so the rules are testable without a DOM.
 */

import type { EngineStateRecord } from './capture-plan';

export type StatusTone = 'ok' | 'busy' | 'error' | 'idle';

export interface StatusLabel {
  label: string;
  tone: StatusTone;
  /** Which engine is actually in use, when there is one. */
  detail: string | null;
}

const ENGINE_NAMES: Record<string, string> = {
  webgpu: 'GPU',
  local: 'CPU',
  remote: 'Hosted',
};

/** The outcome of one Test Connection, as main reports it. */
export interface EndpointProbe {
  ok: boolean;
  /** HTTP status, when there was a response at all. */
  status?: number | null;
  error?: string | null;
  /** How many models the server offered, when it answered. */
  modelCount?: number | null;
}

/**
 * Describe the hosted endpoint using only what was actually observed.
 *
 * The word "Connected" is gone deliberately. It was shown whenever a URL string
 * was non-empty, so typing into the box turned the dot green — and it conflated
 * four separate facts: a URL exists, the host answered, the key was accepted,
 * and a model can be switched.
 *
 * This reports the two we can genuinely establish: whether the host answered,
 * and what it offered. It never claims the key was accepted on a 200, because a
 * server that does not check keys returns 200 to anyone — the one at
 * 192.168.1.169:20300 does exactly that today. Rejection IS provable, so a
 * 401/403 is reported as such. That makes this correct against a server with
 * auth and one without, which is the point.
 */
export function endpointStatusLabel(
  { url, testing = false, probe = null }:
  { url?: string | null; testing?: boolean; probe?: EndpointProbe | null },
): StatusLabel {
  if (!url) return { label: 'Not configured', tone: 'idle', detail: null };
  if (testing) return { label: 'Testing…', tone: 'busy', detail: null };
  if (!probe) return { label: 'Not tested', tone: 'idle', detail: null };

  if (probe.ok) {
    const n = probe.modelCount ?? null;
    return {
      label: 'Reachable',
      tone: 'ok',
      detail: n === null ? null : `${n} model${n === 1 ? '' : 's'}`,
    };
  }

  if (probe.status === 401 || probe.status === 403) {
    return { label: 'Key rejected', tone: 'error', detail: null };
  }

  return { label: probe.error || 'Unreachable', tone: 'error', detail: null };
}

export function statusLabel(state: EngineStateRecord | null): StatusLabel {
  // No record yet is genuinely unknown. Rendering it as Ready is the specific
  // dishonesty this function exists to remove.
  if (!state) return { label: 'Connecting…', tone: 'idle', detail: null };

  const engineName = ENGINE_NAMES[state.engine] ?? state.engine;

  switch (state.status) {
    case 'ready':
      return { label: 'Ready', tone: 'ok', detail: engineName };
    case 'downloading': {
      // Deliberately distinct from 'loading'. Warming a cached model takes ~20s
      // and moves no bytes; fetching the encoder takes ~90s and moves 1.2GB.
      // One word for both is why a blocked press promised "ready shortly" when
      // it might have been minutes.
      const pct = state.progress?.pct;
      return {
        label: Number.isFinite(pct)
          ? `Downloading ${engineName} model — ${pct}%`
          : `Downloading ${engineName} model…`,
        tone: 'busy',
        detail: engineName,
      };
    }
    case 'loading':
      // No number here, ever. There are no bytes in flight to report, so any
      // percentage would be invented — which is the dishonesty this whole
      // module exists to remove.
      return { label: `Loading ${engineName} model…`, tone: 'busy', detail: engineName };
    case 'unusable':
      // Prefer the record's own reason — it is written by whatever made the
      // demotion and is more specific than anything invented here.
      return { label: state.reason || `${engineName} unavailable`, tone: 'error', detail: engineName };
    default:
      return { label: 'Starting up…', tone: 'idle', detail: engineName };
  }
}
