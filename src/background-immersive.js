// Webpage translation identities, cache hydration, and fallback selection.
// Classic scripts share the dedicated background scope; background.js loads them
// synchronously in Chrome, and manifest.json supplies the same order in Firefox.
async function handleImmersiveTranslate(message) {
  const settings = await storageGet(Core.DEFAULT_SETTINGS);
  const preferences = message.preferences || settings;
  const targetLanguage = preferences.immersiveTargetLanguage || settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
  const sourceLanguage = preferences.immersiveSourceLanguage || "auto";
  const service = preferences.immersiveTranslationService || "ai";
  const translationConfig = Core.resolveTranslationConfig(settings, "immersive");
  if (["google-free", "google-cloud", "bing-free"].includes(service)) {
    // A selected built-in service is primary, even when an AI service is configured.
    settings.immersiveFallbackProvider = service;
    Object.assign(translationConfig, { provider: service, apiKey: "", model: "", chatCompletionsUrl: "", generateContentUrl: "" });
  }

  const endpointUrl =
    translationConfig.apiStyle === "gemini"
      ? translationConfig.generateContentUrl
      : translationConfig.chatCompletionsUrl;
  const cues = (Array.isArray(message.items) ? message.items : [])
    .map((item) => ({
      id: item && item.id != null ? String(item.id) : "",
      sourceText: item && item.formattedText
        ? String(item.formattedText).replace(/\s+/g, " ").trim()
        : Core.normalizeSubtitleText(item && item.sourceText),
      plainText: Core.normalizeSubtitleText(item && item.sourceText),
      hasFormatting: Boolean(item && item.formattedText)
    }))
    .filter((item) => item.id && item.sourceText);

  if (!cues.length) {
    return {
      type: "IMMERSIVE_TRANSLATE_RESULT",
      ok: true,
      items: [],
      errors: []
    };
  }

  // Stable text IDs survive DOM reordering, changed batch boundaries and
  // repeated headings in the page outline. Do not include credentials or the
  // URL fragment; keep different pages and translation profiles isolated.
  const cacheKey = `ytbt:immersive:${await immersiveFingerprint(JSON.stringify([
    String(message.pageUrl || "").split("#")[0],
    translationConfig.provider, endpointUrl, translationConfig.model,
    sourceLanguage, targetLanguage, settings.cacheVersion || "1", "immersive-v1"
  ]))}`;
  const identities = await Promise.all(cues.map(async (cue) => ({
    ...cue, cacheId: await immersiveFingerprint(cue.sourceText),
    plainId: await immersiveFingerprint(cue.plainText)
  })));
  const uniqueCues = new Map(identities.map((cue) => [cue.cacheId, { ...cue, id: cue.cacheId }]));
  const cache = await storageGet({ [cacheKey]: { items: {} } });
  const storedItems = cache[cacheKey] && cache[cacheKey].items || {};
  const results = new Map();
  const missing = [];
  for (const cue of uniqueCues.values()) {
    const stored = storedItems[cue.id];
    const legacy = storedItems[cue.plainId];
    if (usableImmersiveCache(stored, cue.sourceText, cue.hasFormatting)) {
      results.set(cue.id, { translatedText: stored.translatedText, translationProvider: stored.translationProvider, cached: true });
    } else if (usableImmersiveCache(legacy, cue.plainText, cue.hasFormatting)) {
      results.set(cue.id, { translatedText: legacy.translatedText, translationProvider: legacy.translationProvider, cached: true });
    } else if (message.cacheOnly === true && completedCueTranslations.has(inFlightCueKey(cacheKey, cue.id, cue.sourceText))) {
      // A successful provider response is still usable while storage is slow
      // or full. Cache probes must never call the provider to recover it.
      results.set(cue.id, { ...completedCueTranslations.get(inFlightCueKey(cacheKey, cue.id, cue.sourceText)), cached: true });
    } else {
      missing.push(cue);
    }
  }

  if (message.cacheOnly !== true && missing.length) {
    const fallbackProvider = ["google-free", "google-cloud", "bing-free"].includes(settings.immersiveFallbackProvider)
      ? settings.immersiveFallbackProvider : "off";
    if (fallbackProvider === "off" && (!translationConfig.apiKey || !endpointUrl || !translationConfig.model)) {
      throw new Error(`${translationConfig.providerLabel} ${!translationConfig.apiKey ? "API Key" : "base URL or model"} is not configured.`);
    }
    const translatedItems = await translateMissingCues({
      cacheKey, translationConfig, targetLanguage, sourceLanguage,
      asrCorrectionEnabled: false,
      cues: missing,
      mode: "immersive",
      translateCues: fallbackProvider === "off" ? undefined : (request, retain) =>
        translateImmersiveWithFallback(request, settings, retain),
      async persistItems(items) {
        const newItems = {};
        for (const item of items) {
          const cue = uniqueCues.get(String(item.id));
          if (cue && item.translatedText) {
            newItems[cue.id] = { sourceText: cue.sourceText, translatedText: item.translatedText,
              translationProvider: item.translationProvider || translationConfig.provider,
              googleTranslationVersion: item.googleTranslationVersion,
              bingTranslationVersion: item.bingTranslationVersion };
          }
        }
        const maxItems = Number(settings.translationCacheMaxItems) || Core.DEFAULT_CACHE_MAX_ITEMS;
        await persistTranslationCache({
          cacheKey,
          cacheValue: { items: newItems, updatedAt: Date.now() },
          maxItems,
          maxItemsPerKey: Math.max(1, Math.min(240, maxItems))
        });
      }
    });
    for (const item of translatedItems) results.set(String(item.id), item);
  }

  return {
    type: "IMMERSIVE_TRANSLATE_RESULT",
    ok: true,
    items: identities.filter((cue) => results.has(cue.cacheId)).map((cue) => ({
      ...results.get(cue.cacheId), id: cue.id
    })),
    errors: []
  };
}

async function immersiveFingerprint(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function usableImmersiveCache(entry, sourceText, hasFormatting) {
  if (!entry || entry.sourceText !== sourceText || typeof entry.translatedText !== "string" || !entry.translatedText.trim()) return false;
  // Only obsolete free-translation formatting results need replacing. Preserve AI and
  // plain-text caches, and never initiate a request during cache-only probes.
  if (!hasFormatting) return true;
  if (["google-free", "google-cloud"].includes(entry.translationProvider)) return entry.googleTranslationVersion === 2;
  if (entry.translationProvider === "bing-free") return entry.bingTranslationVersion === 1;
  return true;
}

// Fallback is opt-in and belongs inside in-flight deduplication. Storage errors
// must never be mistaken for provider failures and trigger another paid call.
async function translateImmersiveWithFallback(request, settings, retain) {
  let items = [];
  let primaryError;
  const config = request.translationConfig;
  const endpoint = config.apiStyle === "gemini" ? config.generateContentUrl : config.chatCompletionsUrl;
  if (config.apiKey && endpoint && config.model) {
    try {
      // Switch provider after one attempt; do not replay the original AI call.
      items = await translateBatch(request);
    } catch (error) {
      primaryError = error;
    }
  }
  const translatedIds = new Set(items.map((item) => String(item.id)));
  const missing = request.cues.filter((cue) => !translatedIds.has(String(cue.id)));
  if (!missing.length) return items;
  if (items.length) await retain(items);
  const deadline = Date.now() + 45000;
  for (const cue of missing) {
    let translatedText;
    try {
      translatedText = await translateGoogleCue(cue.sourceText, request, settings, deadline, cue.hasFormatting);
    } catch (error) {
      // Earlier successes are already cached. Return them so the page can render
      // partial progress; a subsequent click only requests missing paragraphs.
      if (items.length) return items;
      const providerLabel = settings.immersiveFallbackProvider === "bing-free" ? "Bing" : "Google";
      const failure = new Error(`${primaryError ? `主接口失败：${primaryError.message}；` : ""}${providerLabel} 兜底失败：${error.message}`);
      failure.requestMayHaveReachedProvider = Boolean(primaryError?.requestMayHaveReachedProvider || error.requestMayHaveReachedProvider);
      throw failure;
    }
    const bing = settings.immersiveFallbackProvider === "bing-free";
    const item = { id: cue.id, translatedText, translationProvider: settings.immersiveFallbackProvider,
      ...(bing ? { bingTranslationVersion: 1 } : { googleTranslationVersion: 2 }) };
    await retain([item]);
    items.push(item);
  }
  return items;
}

// Translate whole paragraphs, including inline identifiers and formatting.
// Only oversized paragraphs are split, outside formatting and preferably at
// sentence boundaries. No fragment may separate code from its surrounding words
// merely because a code/link/emphasis element starts or ends there.
