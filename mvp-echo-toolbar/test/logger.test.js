/**
 * Item 5 — an Error must log its message, not `{}`.
 *
 * `log()` is variadic and stringifies every non-string argument with
 * JSON.stringify. `JSON.stringify(new Error('boom'))` is `'{}'` — Error's own
 * enumerable properties are empty — so every `log('label:', err)` call site in
 * the app wrote a line ending in a useless `{}`.
 *
 * This is not cosmetic. `EngineManager: processAudio failed: {}` is the line
 * that hid a real, specific error ("transcribe() called on main-process
 * adapter") for an entire debugging session. The failure channel has to carry
 * the failure.
 *
 * Behaviour is asserted through console.log, which `log()` calls with exactly
 * the formatted message, so the module needs no new API surface to be testable.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { log } = require('../app/main/logger.js');

/** Capture the formatted line(s) `log()` emits, without touching the log file. */
function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('logger — Error serialization', () => {
  test('an Error logs its message rather than {}', () => {
    const [line] = captureLog(() => log('EngineManager: processAudio failed:', new Error('boom')));

    assert.ok(!line.includes('{}'), `expected no bare "{}", got: ${line}`);
    assert.match(line, /boom/, 'the error message must survive');
    assert.match(line, /EngineManager: processAudio failed:/, 'the label must survive');
  });

  test('the error name is preserved, so TypeError is distinguishable', () => {
    const [line] = captureLog(() => log('probe:', new TypeError('adapter.requestAdapterInfo is not a function')));

    assert.match(line, /TypeError/);
    assert.match(line, /requestAdapterInfo is not a function/);
  });

  test('a stack trace is included, so the throw site is identifiable', () => {
    const [line] = captureLog(() => log(new Error('with stack')));

    assert.match(line, /logger\.test\.js/, 'the stack should name the file that threw');
  });

  test('a subclassed Error still serializes', () => {
    class AlreadyLoadingError extends Error {
      constructor() {
        super('already loading');
        this.name = 'AlreadyLoadingError';
      }
    }
    const [line] = captureLog(() => log('orchestrator:', new AlreadyLoadingError()));

    assert.match(line, /AlreadyLoadingError/);
    assert.match(line, /already loading/);
  });

  test('plain objects still serialize as JSON, unchanged', () => {
    const [line] = captureLog(() => log('config:', { shortcut: 'Ctrl+Alt+Z', enabled: true }));

    assert.match(line, /\{"shortcut":"Ctrl\+Alt\+Z","enabled":true\}/);
  });

  test('strings pass through untouched and stay joined by a space', () => {
    const [line] = captureLog(() => log('a', 'b', 'c'));

    assert.strictEqual(line, 'a b c');
  });

  test('a circular object does not throw', () => {
    const circular = { name: 'loop' };
    circular.self = circular;

    const [line] = captureLog(() => log('circular:', circular));

    assert.match(line, /circular:/);
  });
});
