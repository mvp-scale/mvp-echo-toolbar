/**
 * Model cache lifecycle for parakeet.js.
 *
 * parakeet.js stores model blobs in IndexedDB ('parakeet-cache-db' / 'file-store').
 * Without intervention Chromium can evict that ~1.2GB blob under storage pressure,
 * forcing a re-download on next launch. This module:
 *
 *   1. Requests persistent storage so the cache survives quota eviction.
 *   2. Tracks the app version that wrote the cache. On version mismatch the
 *      cached files are wiped so the new build re-downloads cleanly.
 */
const DB_NAME = 'parakeet-cache-db';
const STORE_NAME = 'file-store';
const VERSION_KEY = 'mvp-echo:cache-version';

/** Which encoder file this machine can run. Decided by capability, never assumed. */
export type EncoderVariant = 'fp32' | 'fp16';

/**
 * Cache identity is the MODEL and the ENCODER VARIANT — not the app.
 *
 * Bump only when the model or parakeet.js's storage format changes, NEVER on an
 * app-version bump. Legacy values were app versions ("3.0.22") with no "model:"
 * prefix; they migrate silently, so updating the app never re-downloads.
 *
 * fp32 deliberately keeps the ORIGINAL key. Machines that cannot run fp16 —
 * older GPUs, missing shader-f16 — must not be made to re-fetch 2.3GB for a
 * feature they will never use. Only a machine actually switching to fp16 sees a
 * key change, and that change is what evicts the fp32 blobs it just stopped
 * needing. Nothing accumulates: at most one encoder is resident per machine.
 */
export const CACHE_KEYS: Record<EncoderVariant, string> = {
  fp32: 'model:parakeet-tdt-0.6b-v2:1',
  fp16: 'model:parakeet-tdt-0.6b-v2:fp16:1',
};

async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

function openParakeetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function clearParakeetStore(): Promise<void> {
  const db = await openParakeetDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
  db.close();
}

export interface CachePrepResult {
  persistent: boolean;
  cleared: boolean;
  previousVersion: string | null;
  currentVersion: string;
}

/**
 * Prepare the parakeet.js IndexedDB cache for use.
 * Call before the inference worker starts downloading.
 *
 * Requests persistent storage (so the blob survives eviction) and clears the
 * cache ONLY when the MODEL identity changes — not on app-version bumps, which
 * previously forced a needless ~1.2GB re-download on every update.
 */
export async function prepareModelCache(variant: EncoderVariant = 'fp32'): Promise<CachePrepResult> {
  const MODEL_CACHE_VERSION = CACHE_KEYS[variant] ?? CACHE_KEYS.fp32;
  const persistent = await requestPersistence();
  const previousVersion = localStorage.getItem(VERSION_KEY);
  let cleared = false;

  // Only wipe on a real model change: the stored key uses the "model:" scheme
  // and differs from the current one. Legacy app-version values (no "model:"
  // prefix) migrate silently — the model didn't change, so the cached blob is
  // reused and the app update does NOT trigger a re-download.
  const storedModelKey = previousVersion && previousVersion.startsWith('model:') ? previousVersion : null;
  if (storedModelKey && storedModelKey !== MODEL_CACHE_VERSION) {
    try {
      await clearParakeetStore();
      cleared = true;
      console.log(`[ModelCache] Model changed (${storedModelKey} → ${MODEL_CACHE_VERSION}) — cleared cache`);
    } catch (e) {
      // Do NOT advance the key on a failed clear, or the next run treats a
      // stale/partial cache as fresh. Keep the old key and bail.
      console.warn('[ModelCache] Failed to clear stale cache — keeping old key:', e);
      return { persistent, cleared, previousVersion, currentVersion: storedModelKey };
    }
  }

  localStorage.setItem(VERSION_KEY, MODEL_CACHE_VERSION);
  console.log(
    `[ModelCache] persistent=${persistent} cleared=${cleared} key=${MODEL_CACHE_VERSION}` +
    (previousVersion ? ` (was ${previousVersion})` : ' (first run)')
  );
  return { persistent, cleared, previousVersion, currentVersion: MODEL_CACHE_VERSION };
}
