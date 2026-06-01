const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = path.join(os.tmpdir(), 'mvp-echo-toolbar-debug.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB ceiling within a session

/**
 * Centralized logging for the main process.
 * Writes to both console and the debug log file.
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    // Bound the file: the renderer forwards every console line here, so a long
    // session (days of uptime) would otherwise grow it without limit. At the cap,
    // keep the most recent half rather than wiping to empty — a days-long session
    // must retain the lead-up to an intermittent failure for diagnosis.
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
      try {
        const data = fs.readFileSync(logPath, 'utf8');
        fs.writeFileSync(logPath, data.slice(-Math.floor(MAX_LOG_BYTES / 2)));
      } catch (_e) {
        fs.writeFileSync(logPath, '');
      }
    }
    fs.appendFileSync(logPath, logMessage);
  } catch (err) {
    // Ignore log write errors
  }
}

/**
 * Clear the log file (called on app startup).
 */
function clearLog() {
  try {
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

module.exports = { log, clearLog, getLogPath };
