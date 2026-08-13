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

/**
 * Minimal ALWAYS-ON info log — one concise line per recording for everyday
 * observability, with NO --diag flag needed. Reaches the persisted debug log
 * (via main) and the live console. Distinct from dlog() (verbose, diag-only).
 *
 * Keep these lines METRICS-ONLY — never the transcript text — so spoken words
 * never land in the on-disk log; the full text lives in the popup/clipboard (and
 * under --diag). Uses console.info (not the diag-gated console.log) so it stays
 * visible in default mode, and invokes the always-on debug-log channel directly.
 */
export function ilog(line: string): void {
  try { console.info(line); } catch { /* ok */ }
  const ipc = (window as any).electron?.ipcRenderer;
  try { ipc?.invoke('debug:renderer-log', line); } catch { /* best-effort */ }
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

/**
 * Decode a WAV written by {@link saveDiagAudio} back to PCM.
 *
 * Used by the `--replay` path so a saved recording can be pushed through the
 * exact transcription pipeline again. That turns "read the script and hope you
 * read it the same way" into a deterministic before/after: the same bytes, the
 * same model, so any difference in output is the code change.
 *
 * Only handles the format we write (16-bit mono PCM), which is all it needs to.
 */
export function decodeWav(buf: ArrayBuffer): { pcm: Float32Array; sampleRate: number } {
  const v = new DataView(buf);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

  let sampleRate = 16000;
  let bitsPerSample = 16;
  let channels = 1;
  let dataOff = -1;
  let dataLen = 0;

  // Walk the chunk list rather than assuming a 44-byte header — some writers
  // insert LIST/fact chunks before `data`.
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      bitsPerSample = v.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error('no data chunk');
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}`);

  const frames = Math.floor(dataLen / 2 / channels);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // Mixdown is unnecessary today (we only ever write mono) but taking the
    // first channel keeps a stereo file from being read as garbage.
    pcm[i] = v.getInt16(dataOff + i * 2 * channels, true) / 0x8000;
  }
  return { pcm, sampleRate };
}
