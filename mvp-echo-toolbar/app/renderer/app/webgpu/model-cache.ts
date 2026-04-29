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
 */
export async function prepareModelCache(appVersion: string): Promise<CachePrepResult> {
  const persistent = await requestPersistence();
  const previousVersion = localStorage.getItem(VERSION_KEY);
  let cleared = false;

  if (previousVersion && previousVersion !== appVersion) {
    try {
      await clearParakeetStore();
      cleared = true;
      console.log(`[ModelCache] Cleared cache from previous version ${previousVersion}`);
    } catch (e) {
      console.warn('[ModelCache] Failed to clear stale cache:', e);
    }
  }

  localStorage.setItem(VERSION_KEY, appVersion);
  console.log(
    `[ModelCache] persistent=${persistent} cleared=${cleared} version=${appVersion}` +
    (previousVersion ? ` (was ${previousVersion})` : ' (first run)')
  );
  return { persistent, cleared, previousVersion, currentVersion: appVersion };
}
