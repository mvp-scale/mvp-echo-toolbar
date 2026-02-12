const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = path.join(os.tmpdir(), 'mvp-echo-toolbar-debug.log');

/**
 * Centralized logging for the main process.
 * Writes to both console and the debug log file.
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
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
