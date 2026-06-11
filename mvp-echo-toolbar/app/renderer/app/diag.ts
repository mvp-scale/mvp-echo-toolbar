/**
 * Diagnostics gate (renderer).
 *
 * Default OFF → quiet console. Turned on at launch via `--diag` CLI arg or the
 * MVP_DEBUG env var (read in the main process, queried here on startup).
 *
 * - `dlog(...)` — verbose/"table-stakes" logging. Silent unless diagnostics are on.
 * - `sendDiag(line)` — emit one structured line to the dedicated diagnostics file
 *   (main appends it, timestamped). No-op unless diagnostics are on.
 * Real errors/warnings should still use console.error/console.warn directly.
 */

let enabled = false;

export function setDiagEnabled(v: boolean): void {
  enabled = !!v;
}

export function isDiagEnabled(): boolean {
  return enabled;
}

/** Verbose log — only reaches the console when diagnostics are enabled. */
export function dlog(...args: any[]): void {
  if (enabled) console.log(...args);
}

/** Append one structured line to the diagnostics file (main writes it). */
export function sendDiag(line: string): void {
  if (!enabled) return;
  const ipc = (window as any).electron?.ipcRenderer;
  try { ipc?.invoke('diag:record', line); } catch { /* best-effort */ }
}

/** Short, stable fingerprint of a device identity string (djb2 → 4 hex). */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return (h & 0xffff).toString(16).padStart(4, '0');
}

/** Encode mono Float32 PCM [-1,1] as a 16-bit PCM WAV (playable anywhere). */
function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);   // PCM
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);            // mono
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

/**
 * Persist the exact captured PCM to a WAV file (diagnostics only) so it can be
 * played back — the ground-truth test for "captured fine vs sparse vs corrupted".
 */
export function saveDiagAudio(name: string, pcm: Float32Array, sampleRate: number): void {
  if (!enabled || !pcm || pcm.length === 0) return;
  const ipc = (window as any).electron?.ipcRenderer;
  try { ipc?.invoke('diag:save-audio', name, encodeWav(pcm, sampleRate)); } catch { /* best-effort */ }
}
