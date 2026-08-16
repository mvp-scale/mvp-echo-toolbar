/**
 * Items 25 & 26 — the IPC surface must agree with itself.
 *
 * Three lists have to match and nothing enforced it:
 *   1. ipcMain.handle(...) registrations   (main-simple.js, engine-manager.js)
 *   2. the preload allowlist               (preload.js)
 *   3. renderer invoke(...) call sites     (app/renderer/**)
 *
 * When they drift the failure is SILENT. preload's invoke() returns undefined
 * for a channel that is not on the allowlist — no throw, no warning — and every
 * consumer reads undefined as "no config yet". A typo'd or newly added channel
 * therefore looks like an empty response rather than a mistake.
 *
 * This is checked by reading source rather than running anything: the three
 * lists are all statically visible, so the whole class is catchable with no
 * jsdom, no Electron, and no new dependency.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Every file under a directory matching an extension list. */
function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

// ── The three lists ────────────────────────────────────────────────────────

const HANDLER_SOURCES = ['app/main/main-simple.js', 'app/stt/engine-manager.js'];

const handlers = new Set(
  HANDLER_SOURCES.flatMap((f) => matchAll(read(f), /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)),
);

const preloadSrc = read('app/preload/preload.js');

/** The allowlist array in preload's `electron` bridge. */
const allowlist = new Set(
  (preloadSrc.match(/const validChannels\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean),
);

/** Channels preload itself invokes on the renderer's behalf (electronAPI bridge). */
const preloadInvokes = new Set(matchAll(preloadSrc, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g));

/** Channels the renderer invokes directly through the allowlisted bridge. */
const rendererInvokes = new Set(
  walk('app/renderer', ['.ts', '.tsx']).flatMap((f) =>
    matchAll(read(f), /\.invoke\(\s*['"]([^'"]+)['"]/g),
  ),
);

// ── Contracts ──────────────────────────────────────────────────────────────

describe('IPC contract — the three lists must agree', () => {
  test('the lists were actually parsed (guards against a vacuous suite)', () => {
    // Without this, a regex that silently stops matching turns every assertion
    // below into "no items, therefore no failures".
    assert.ok(handlers.size > 10, `expected many handlers, parsed ${handlers.size}`);
    assert.ok(allowlist.size > 5, `expected an allowlist, parsed ${allowlist.size}`);
    assert.ok(rendererInvokes.size > 5, `expected renderer invokes, parsed ${rendererInvokes.size}`);
  });

  test('every channel the renderer invokes has a main-process handler', () => {
    const missing = [...rendererInvokes].filter((c) => !handlers.has(c));

    assert.deepStrictEqual(missing, [],
      `renderer invokes channels with no ipcMain.handle: ${missing.join(', ')}`);
  });

  test('every channel the renderer invokes is on the preload allowlist', () => {
    // Not being listed does not error — invoke() falls off the end and returns
    // undefined, which consumers read as "no config yet".
    const blocked = [...rendererInvokes].filter((c) => !allowlist.has(c));

    assert.deepStrictEqual(blocked, [],
      `renderer invokes channels the preload allowlist silently drops: ${blocked.join(', ')}`);
  });

  test('every channel preload invokes on the renderer\'s behalf has a handler', () => {
    const missing = [...preloadInvokes].filter((c) => !handlers.has(c));

    assert.deepStrictEqual(missing, [],
      `preload invokes channels with no ipcMain.handle: ${missing.join(', ')}`);
  });

  test('the allowlist contains no channel that has no handler', () => {
    const orphans = [...allowlist].filter((c) => !handlers.has(c));

    assert.deepStrictEqual(orphans, [],
      `allowlisted but unhandled (dead or renamed): ${orphans.join(', ')}`);
  });
});

describe('IPC contract — an unlisted channel must fail loudly', () => {
  test('preload throws rather than returning undefined for an unknown channel', () => {
    // Item 25. The original had no else branch at all, so a typo resolved to
    // undefined and was indistinguishable from an empty result. Asserted against
    // source because the bridge cannot be instantiated outside Electron; it is a
    // weak check, but it guards the exact line that regressed.
    const invokeBody = (preloadSrc.match(/invoke:\s*\([\s\S]*?\n\s{4}\},/) || [''])[0];

    assert.match(invokeBody, /throw new Error/,
      'preload invoke() must throw for a channel that is not allowlisted');
  });
});
