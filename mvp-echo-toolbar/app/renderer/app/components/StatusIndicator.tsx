/**
 * Compact status indicator for the popup status bar.
 *
 * This used to take no props and render a hardcoded green dot and the literal
 * "Ready" — so the one window a user opens to find out what is wrong asserted
 * that nothing was, including while the hotkey was dead. It now derives from
 * the authoritative engine record; the rules live in engine-status-label.ts so
 * they can be tested without a DOM.
 */

import { statusLabel } from '../engine-status-label';
import type { EngineStateRecord } from '../../../stt/capture-plan';

const TONE_STYLES: Record<string, { dot: string; text: string }> = {
  ok: { dot: 'bg-green-500', text: 'text-green-600' },
  busy: { dot: 'bg-blue-400 animate-pulse', text: 'text-blue-500' },
  error: { dot: 'bg-red-500', text: 'text-red-500' },
  idle: { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
};

export default function StatusIndicator({ engineState }: { engineState?: EngineStateRecord | null }) {
  const { label, tone, detail } = statusLabel(engineState ?? null);
  const style = TONE_STYLES[tone] ?? TONE_STYLES.idle;

  return (
    <div className="flex items-center gap-1 min-w-0">
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
      <span className={`font-medium truncate ${style.text}`} title={label}>{label}</span>
      {detail && tone === 'ok' && (
        <span className="text-[9px] text-muted-foreground shrink-0">{detail}</span>
      )}
    </div>
  );
}
