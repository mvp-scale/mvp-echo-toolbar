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

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(flushQueue);
}

function flushQueue() {
  flushScheduled = false;
  if (queue.length === 0) return;
  const batch = queue.join('');
  queue = [];

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
    fs.appendFile(logPath, batch, () => { /* ignore write errors */ });
  } catch (err) {
    // Ignore log write errors
  }
}

function log(message) {
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
