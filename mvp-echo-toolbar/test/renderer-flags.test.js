/**
 * A flag the preload reads must actually be forwarded to the renderer.
 *
 * The preload runs in the RENDERER process, whose command line is Chromium's,
 * not the app's. Measured under Electron 43 with the app launched
 * `--model-store`:
 *
 *   MAIN    argv has --model-store: true
 *   PRELOAD argv has --model-store: false
 *   PRELOAD argv sample: ["/proc/self/exe","--type=renderer",
 *                         "--enable-crash-reporter=...","--user-data-dir=..."]
 *
 * So `process.argv.includes('--model-store')` in preload.js was ALWAYS false —
 * dev and packaged alike. The on-disk model store had no working way to be
 * enabled, and every run silently took the hub path while the log said
 * `source=hub` and nobody could tell whether the store was broken or simply
 * never asked. `--diag` escaped this only because it is answered over IPC.
 *
 * The failure mode is silence in both directions, which is exactly what a
 * source-read test is for: the two lists are statically visible.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const preloadSrc = read('app/preload/preload.js');
const mainSrc = read('app/main/main-simple.js');

/** Flags the preload tests for on its own argv. */
const preloadFlags = [...preloadSrc.matchAll(/process\.argv\.includes\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map((m) => m[1]);

/**
 * Flags main forwards onto the renderer's argv.
 *
 * Read out of rendererFlags()'s body rather than from around the
 * `additionalArguments:` call sites — the sites pass the function, so the flag
 * literals only ever appear in one place.
 */
const rendererFlagsFn = (mainSrc.match(/function rendererFlags\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
const forwarded = [...rendererFlagsFn.matchAll(/['"](--[a-z0-9-]+)['"]/g)].map((m) => m[1]);

describe('renderer flag forwarding', () => {
  test('both lists were actually parsed (guards a vacuous test)', () => {
    assert.ok(preloadFlags.length > 0,
      'if this drops to zero the assertions below stop meaning anything');
    assert.ok(rendererFlagsFn.length > 0,
      'rendererFlags() was not found — a rename here makes the next assertion pass for the wrong reason');
  });

  test('every flag the preload reads is forwarded via additionalArguments', () => {
    const orphans = preloadFlags.filter((f) => !forwarded.includes(f));

    assert.deepStrictEqual(orphans, [],
      `preload reads these off its own argv but main never forwards them, so they are ` +
      `permanently false: ${orphans.join(', ')}`);
  });

  test('every window that loads the preload forwards the flags', () => {
    // One window without it is a flag that works in the popup and not in the
    // hidden capture window — the hardest kind of difference to spot.
    const preloadWindows = (mainSrc.match(/preload: preloadPath/g) || []).length;
    const withArgs = (mainSrc.match(/additionalArguments: rendererFlags\(\)/g) || []).length;

    assert.strictEqual(withArgs, preloadWindows,
      `${preloadWindows} windows load the preload but only ${withArgs} forward flags to it`);
  });

  test('main reads the flag from its OWN argv, which is where it really lands', () => {
    assert.match(mainSrc, /rendererFlags[\s\S]{0,300}process\.argv\.includes\(\s*['"]--no-model-store['"]\s*\)/,
      'the decision must be made in main, the only process that sees the app CLI');
  });
});
