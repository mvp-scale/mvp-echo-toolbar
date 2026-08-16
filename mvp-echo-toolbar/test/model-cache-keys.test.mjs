/**
 * The cache key decides who re-downloads a multi-gigabyte model.
 *
 * `prepareModelCache()` wipes the parakeet IndexedDB store whenever the stored
 * key differs from the current one. That is the self-cleaning mechanism — the
 * fp32 blobs are evicted by the same act that switches a machine to fp16, so at
 * most one encoder is ever resident.
 *
 * It is also a loaded gun. Changing the fp32 key costs EVERY existing user a
 * 2,362 MB re-download for no benefit, silently, on first launch after update.
 * That has happened before on this project (v3.0.23, an app-version-keyed cache
 * wipe), which is why the key is asserted here rather than merely commented.
 *
 * These are constants, so the test is trivial — and that is the point: the
 * expensive mistake is a one-character edit, and nothing else would catch it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { CACHE_KEYS } = await import('../app/renderer/app/webgpu/model-cache.ts');

describe('model cache keys', () => {
  test('fp32 keeps the ORIGINAL key, so existing installs never re-download', () => {
    // Do not "fix" this string. It is the value already written to every
    // existing user's localStorage; changing it wipes their 2.3GB cache.
    assert.strictEqual(CACHE_KEYS.fp32, 'model:parakeet-tdt-0.6b-v2:1');
  });

  test('fp16 uses a DIFFERENT key, which is what evicts the fp32 blobs', () => {
    assert.notStrictEqual(CACHE_KEYS.fp16, CACHE_KEYS.fp32,
      'identical keys would leave 2.3GB of fp32 weights behind forever');
  });

  test('every key carries the model: prefix the migration logic keys on', () => {
    // prepareModelCache treats a stored value WITHOUT this prefix as a legacy
    // app-version string and migrates it silently. A key missing the prefix
    // would therefore never trigger a wipe when it should.
    for (const [variant, key] of Object.entries(CACHE_KEYS)) {
      assert.ok(key.startsWith('model:'), `${variant} key must start with "model:" — got "${key}"`);
    }
  });

  test('the keys name the model, so a future model change is visibly a new key', () => {
    for (const [variant, key] of Object.entries(CACHE_KEYS)) {
      assert.match(key, /parakeet-tdt-0\.6b-v2/, `${variant} key must identify the model`);
    }
  });
});
