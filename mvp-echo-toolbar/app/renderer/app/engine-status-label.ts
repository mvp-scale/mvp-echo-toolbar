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

import type { EngineStateRecord } from '../../stt/capture-plan';

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

export function statusLabel(state: EngineStateRecord | null): StatusLabel {
  // No record yet is genuinely unknown. Rendering it as Ready is the specific
  // dishonesty this function exists to remove.
  if (!state) return { label: 'Connecting…', tone: 'idle', detail: null };

  const engineName = ENGINE_NAMES[state.engine] ?? state.engine;

  switch (state.status) {
    case 'ready':
      return { label: 'Ready', tone: 'ok', detail: engineName };
    case 'loading':
      return { label: `Loading ${engineName} model…`, tone: 'busy', detail: engineName };
    case 'unusable':
      // Prefer the record's own reason — it is written by whatever made the
      // demotion and is more specific than anything invented here.
      return { label: state.reason || `${engineName} unavailable`, tone: 'error', detail: engineName };
    default:
      return { label: 'Starting up…', tone: 'idle', detail: engineName };
  }
}
