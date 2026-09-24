// Shared background settings, request state, and storage helpers.
// Classic scripts share the dedicated background scope; background.js loads them
// synchronously in Chrome, and manifest.json supplies the same order in Firefox.
const Core = globalThis.YTBTCore;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 60000;
const SEGMENTATION_BATCH_SIZE = 40;
const MAX_SEGMENTATION_CARRY_CUES = 6;
const MAX_SEGMENTATION_CACHE_ENTRIES = 40;
const CACHE_PREFIX = "ytbt:";
// In-memory count of cached cue translations so we usually avoid a full storage
// scan on every write. Reset on service-worker restart; refreshed on demand.
let cachedItemCount = null;
const inFlightCueTranslations = new Map();
const inFlightSentenceSegmentations = new Map();
// Keep paid results available if a storage write fails, and while a request that
// read an older storage snapshot catches up with a just-completed batch.
const completedCueTranslations = new Map();
let translationCacheWriteQueue = Promise.resolve();

function storageGet(defaults) {
  return new Promise((resolve, reject) => chrome.storage.local.get(defaults, (values) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(`Unable to read subtitle cache: ${error.message}`));
    else resolve(values);
  }));
}

function storageSet(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(`Unable to save subtitle cache: ${error.message}`));
    else resolve();
  }));
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.remove(keys, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(`Unable to remove subtitle cache: ${error.message}`));
    else resolve();
  }));
}
