/**
 * The tray state table.
 *
 * The tray is the only surface that is always visible, so what it asserts
 * matters more than anything in the popup. Two things it used to get wrong:
 *
 *   1. A download had no state of its own, so pressing the hotkey during one
 *      flashed the RED error icon — identical to a genuine crash.
 *   2. Every flash reverts to the literal 'ready' after 3s (tray-flash.ts), so a
 *      flash during a 90s download ended with the tray claiming Ready while the
 *      hotkey was still refusing to record.
 *
 * Requiring tray-manager outside Electron is safe: `require('electron')` returns
 * a path string, so Tray/Menu/nativeImage destructure to undefined and nothing
 * here calls them. The icon cache is pre-warmed so getIcon() never reaches
 * nativeImage.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const TrayManager = require('../app/main/tray-manager');
const { STATES } = require('../app/main/tray-manager');

/** A TrayManager with a fake tray, so setState can be exercised off-Electron. */
function fakeTray() {
  const mgr = new TrayManager();
  const calls = { image: [], tooltip: [] };
  mgr.tray = {
    setImage: (i) => calls.image.push(i),
    setToolTip: (t) => calls.tooltip.push(t),
  };
  for (const name of Object.keys(STATES)) mgr.iconCache[name] = `icon:${name}`;
  return { mgr, calls, tooltip: () => calls.tooltip[calls.tooltip.length - 1] };
}

describe('tray states', () => {
  test('a download has a state of its own', () => {
    assert.ok(STATES.downloading, 'without this a download can only borrow another state');
  });

  test('it is NOT the error state', () => {
    // The whole point. A download is a wait, not a failure, and it must not
    // wear the icon a crash wears.
    assert.notStrictEqual(STATES.downloading.icon, STATES.error.icon);
    assert.doesNotMatch(STATES.downloading.tooltip, /error/i);
  });

  test('it reuses an existing icon rather than needing a new asset', () => {
    // Same choice `starting` already makes: the "busy, don't press yet" icon,
    // with the tooltip carrying the distinction.
    const icons = Object.entries(STATES)
      .filter(([name]) => name !== 'downloading')
      .map(([, s]) => s.icon);

    assert.ok(icons.includes(STATES.downloading.icon), 'a new PNG is not needed for this');
  });

  test('the tooltip says what is happening', () => {
    assert.match(STATES.downloading.tooltip, /download/i);
  });
});

describe('setState carries a detail into the tooltip', () => {
  test('a percentage is appended when given', () => {
    const { mgr, tooltip } = fakeTray();

    mgr.setState('downloading', '47%');

    assert.match(tooltip(), /47%/, 'the tray is the one always-visible surface — the number belongs here');
    assert.match(tooltip(), /download/i, 'and it still says what it is doing');
  });

  test('no detail leaves the tooltip exactly as it was', () => {
    const { mgr, tooltip } = fakeTray();

    mgr.setState('recording');

    assert.strictEqual(tooltip(), STATES.recording.tooltip);
  });

  test('a detail on one state does not leak into the next', () => {
    const { mgr, tooltip } = fakeTray();

    mgr.setState('downloading', '47%');
    mgr.setState('ready');

    assert.doesNotMatch(tooltip(), /47%/, 'a stale percentage on Ready is a lie that persists');
  });

  test('an unknown state is ignored rather than throwing', () => {
    const { mgr } = fakeTray();

    assert.doesNotThrow(() => mgr.setState('nonsense'));
  });
});
