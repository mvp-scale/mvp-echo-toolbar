const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = path.join(os.tmpdir(), 'mvp-echo-toolbar-debug.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB ceiling within a session

/**
 * Centralized logging for the main process.
 * Writes to both console and the debug log file.
 */
// Pending lines, flushed on a microtask. The renderer forwards every
// console.error/warn through here, so a burst used to mean a burst of
// SYNCHRONOUS disk writes on the main process — blocking the tray, the popup
// and every IPC handler for the duration, on volume main doesn't control.
let queue = [];
let flushScheduled = false;
let writtenBytes = 0;
let writing = false;   // an fs.appendFile is currently in flight

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(flushQueue);
}

function flushQueue() {
  flushScheduled = false;
  // Only ONE append may be in flight. fs.appendFile does not serialize
  // overlapping calls, so a second flush landing while the first is still
  // writing interleaves the two buffers and corrupts lines mid-character.
  if (writing || queue.length === 0) return;
  const batch = queue.join('');
  queue = [];
  writing = true;

  // Bound the file: a long session (days of uptime) would otherwise grow it
  // without limit. At the cap, keep the most recent half rather than wiping to
  // empty — a days-long session must retain the lead-up to an intermittent
  // failure for diagnosis. Tracked in-process so the common path needs no stat.
  try {
    if (writtenBytes > MAX_LOG_BYTES) {
      try {
        const data = fs.readFileSync(logPath, 'utf8');
        const kept = data.slice(-Math.floor(MAX_LOG_BYTES / 2));
        fs.writeFileSync(logPath, kept);
        writtenBytes = Buffer.byteLength(kept);
      } catch (_e) {
        fs.writeFileSync(logPath, '');
        writtenBytes = 0;
      }
    }
    writtenBytes += Buffer.byteLength(batch);
    fs.appendFile(logPath, batch, () => {
      writing = false;
      // Anything queued while this write was in flight goes out next.
      if (queue.length > 0) scheduleFlush();
    });
  } catch (err) {
    writing = false;
  }
}

function log(...parts) {
  // Variadic: callers pass `log('label:', value)` in several places and the
  // single-parameter version silently dropped everything after the first,
  // producing log lines that ended in a bare colon.
  const message = parts
    .map((p) => (typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()))
    .join(' ');
  const timestamp = new Date().toISOString();
  console.log(message);
  queue.push(`[${timestamp}] ${message}\n`);
  scheduleFlush();
}

/** Flush synchronously — for shutdown, where a microtask may never run. */
function flushSync() {
  flushScheduled = false;
  if (queue.length === 0) return;
  const batch = queue.join('');
  queue = [];
  try { fs.appendFileSync(logPath, batch); } catch (_e) { /* ignore */ }
}

/**
 * Clear the log file (called on app startup).
 */
function clearLog() {
  try {
    queue = [];
    writtenBytes = 0;
    fs.writeFileSync(logPath, '');
  } catch (err) {
    // Ignore
  }
}

/**
 * Get the log file path.
 */
function getLogPath() {
  return logPath;
}

module.exports = { log, clearLog, getLogPath, flushSync };
