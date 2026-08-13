/**
 * Fixes 1 and 5 — AudioCapture readiness gating and device-change safety.
 *
 * See _review/FIX-PLAN.md (DoD v2), _review/raw/03-audio-capture.md,
 * and _review/recon/C-audiocapture-fix-design.md.
 *
 * 1: the `devicechange` listener called releaseMicStream() unconditionally,
 *    stopping the mic track mid-recording. No error is raised — the worklet
 *    simply stops receiving frames and the user sees "no speech".
 * 5: the cold path gates the "talk now" cue on track.muted + real audio
 *    energy. The WARM path (the default under keep-ready) fired it
 *    immediately with no checks at all, so the cue could fire into a device
 *    that wasn't delivering audio yet.
 *
 * These exercise the class's own state; nothing here touches the DOM, so no
 * jsdom is required (per recon C).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { AudioCapture } = await import('../app/renderer/app/audio/AudioCapture.ts');

/** A MediaStream stand-in that records whether its tracks were stopped. */
function fakeStream({ muted = false } = {}) {
  const track = {
    kind: 'audio',
    readyState: 'live',
    muted,
    stopped: false,
    stop() { this.stopped = true; this.readyState = 'ended'; },
    getSettings: () => ({}),
  };
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

describe('Fix 1 — devicechange must not stop a live recording', () => {
  test('defers the mic release while a recording is in progress', () => {
    const cap = new AudioCapture();
    const stream = fakeStream();
    cap.rawStream = stream;
    cap.rawWorklet = {}; // truthy => a recording is live

    cap.requestMicRelease('devicechange');

    assert.strictEqual(stream.track.stopped, false,
      'the live mic track must not be stopped mid-recording');
    assert.strictEqual(cap.rawStream, stream, 'the stream must still be attached');
    assert.strictEqual(cap.micReleasePending, true, 'the release must be recorded as pending');
  });

  test('releases immediately when no recording is in progress', () => {
    const cap = new AudioCapture();
    const stream = fakeStream();
    cap.rawStream = stream;
    cap.rawWorklet = undefined; // idle

    cap.requestMicRelease('devicechange');

    assert.strictEqual(stream.track.stopped, true,
      'an idle warm stream should still be released on a device change');
    assert.strictEqual(cap.rawStream, undefined);
  });

  test('a deferred release is applied once the recording stops', () => {
    const cap = new AudioCapture();
    const stream = fakeStream();
    cap.rawStream = stream;
    cap.rawWorklet = {};

    cap.requestMicRelease('devicechange');
    assert.strictEqual(stream.track.stopped, false);

    // Recording has ended; the class flushes the deferred release.
    cap.rawWorklet = undefined;
    cap.applyPendingMicRelease();

    assert.strictEqual(stream.track.stopped, true,
      'the deferred release must actually happen after the recording ends');
    assert.strictEqual(cap.micReleasePending, false);
  });
});

describe('Fix 5 — the ready cue requires real audio, warm path included', () => {
  /** Drive N samples of above-floor audio through the readiness gate. */
  function feed(cap, { samples, rms, needed }) {
    cap.maybeFireCaptureReady(samples, rms, needed);
  }

  test('does not fire while the track is still muted', () => {
    const cap = new AudioCapture();
    const stream = fakeStream({ muted: true });
    cap.rawStream = stream;
    let fired = false;
    cap.onCaptureReady = () => { fired = true; };

    feed(cap, { samples: 16000, rms: 0.05, needed: 800 });

    assert.strictEqual(fired, false,
      'a muted track means the device has not finished its unmute transition');
  });

  test('fires once enough above-floor audio has flowed', () => {
    const cap = new AudioCapture();
    cap.rawStream = fakeStream();
    let fired = 0;
    cap.onCaptureReady = () => { fired += 1; };

    feed(cap, { samples: 800, rms: 0.05, needed: 800 });

    assert.strictEqual(fired, 1, 'the cue should fire when real energy has flowed');
  });

  test('resets its counter on a below-floor chunk so energy must be contiguous', () => {
    const cap = new AudioCapture();
    cap.rawStream = fakeStream();
    let fired = 0;
    cap.onCaptureReady = () => { fired += 1; };

    feed(cap, { samples: 400, rms: 0.05, needed: 800 });   // half way
    feed(cap, { samples: 400, rms: 0.0001, needed: 800 }); // silence -> reset
    feed(cap, { samples: 400, rms: 0.05, needed: 800 });   // half way again

    assert.strictEqual(fired, 0, 'scattered energy must not sum its way to ready');
  });

  test('the warm threshold is shorter than the cold one but not zero', () => {
    const warm = AudioCapture.readySamplesFor(16000, true);
    const cold = AudioCapture.readySamplesFor(16000, false);

    assert.ok(warm > 0, 'warm must still require real audio — this is the whole fix');
    assert.ok(warm < cold, 'warm must be cheaper than cold to preserve the latency win');
    assert.ok(warm <= 16000 * 0.1, 'warm gate should cost no more than ~100ms');
  });
});
