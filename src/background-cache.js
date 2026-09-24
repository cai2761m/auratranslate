// Serialized cache persistence and eviction.
// Classic scripts share the dedicated background scope; background.js loads them
// synchronously in Chrome, and manifest.json supplies the same order in Firefox.
// Write a video's translation cache back, evicting least-recently-updated video
// keys when the total cached-cue count would exceed the configured ceiling.
// Eviction granularity is per video (each `ytbt:` key), matching the natural
// "least recently watched video" semantics.
function persistTranslationCache(request) {
  // The read, merge, eviction and write form one operation. Parallel batches
  // must not each overwrite the same video's cache from an older snapshot.
  const write = translationCacheWriteQueue.then(() => writeTranslationCache(request));
  translationCacheWriteQueue = write.catch(() => {});
  return write;
}

async function writeTranslationCache({ cacheKey, cacheValue, maxItems, maxItemsPerKey }) {
  const latest = await storageGet({ [cacheKey]: { items: {}, updatedAt: 0 } });
  const latestValue = latest[cacheKey] || { items: {}, updatedAt: 0 };
  const latestItems = latestValue.items && typeof latestValue.items === "object" ? latestValue.items : {};
  const incomingItems = cacheValue.items && typeof cacheValue.items === "object" ? cacheValue.items : {};
  let mergedItems = Object.assign({}, latestItems, incomingItems);
  if (maxItemsPerKey) {
    mergedItems = Object.fromEntries(Object.entries(latestItems)
      .filter(([key]) => !Object.hasOwn(incomingItems, key))
      .concat(Object.entries(incomingItems)).slice(-maxItemsPerKey));
  }
  const actualAddedCount = Object.keys(mergedItems).length - Object.keys(latestItems).length;
  cacheValue = Object.assign({}, latestValue, cacheValue, {
    items: mergedItems,
    updatedAt: Date.now()
  });
  // Lazily initialize the in-memory count once per service-worker lifetime.
  if (cachedItemCount == null) {
    cachedItemCount = await countCachedTranslationItems();
  }

  let nextItemCount = cachedItemCount + actualAddedCount;

  try {
    if (nextItemCount > maxItems) {
      const evicted = await evictOldestCacheKeys(nextItemCount - maxItems, cacheKey);
      nextItemCount -= evicted.freedItems;
    }
    await storageSet({ [cacheKey]: cacheValue });
    cachedItemCount = nextItemCount;
  } catch (error) {
    // A failed write/removal must be visible, and cannot advance the count.
    // Re-read it on the next save in case some eviction already succeeded.
    cachedItemCount = null;
    throw error;
  }
}

// Count cached cue translations across every `ytbt:` storage key.
async function countCachedTranslationItems() {
  const all = await storageGet(null);
  let total = 0;
  for (const key of Object.keys(all)) {
    if (!key.startsWith(CACHE_PREFIX)) {
      continue;
    }
    const entry = all[key];
    if (entry && typeof entry === "object" && entry.items) {
      total += Object.keys(entry.items).length;
    }
  }
  return total;
}

// Remove oldest video cache keys until at least `itemsToFree` cue slots are
// reclaimed. The current key is never evicted. Returns how many items freed.
async function evictOldestCacheKeys(itemsToFree, currentKey) {
  if (itemsToFree <= 0) {
    return { freedItems: 0 };
  }
  const all = await storageGet(null);
  const entries = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(CACHE_PREFIX) || key === currentKey) {
      continue;
    }
    const entry = all[key];
    if (!entry || typeof entry !== "object" || !entry.items) {
      continue;
    }
    entries.push({
      key,
      updatedAt: Number(entry.updatedAt) || 0,
      itemCount: Object.keys(entry.items).length
    });
  }
  entries.sort((left, right) => left.updatedAt - right.updatedAt);

  let freed = 0;
  const removeKeys = [];
  for (const entry of entries) {
    if (freed >= itemsToFree) {
      break;
    }
    removeKeys.push(entry.key);
    freed += entry.itemCount;
  }
  if (removeKeys.length) {
    await storageRemove(removeKeys);
  }
  return { freedItems: freed };
}
