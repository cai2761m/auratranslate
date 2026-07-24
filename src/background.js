importScripts("shared.js");

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "TRANSLATE_BATCH") {
    handleTranslateBatch(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "TRANSLATE_RESULT",
          ok: false,
          videoId: message.videoId,
          items: [],
          errors: [{ message: error && error.message ? error.message : String(error) }]
        });
      });

    return true;
  }

  if (message.type === "SEGMENT_SUBTITLES") {
    handleSegmentSubtitles(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "SEGMENT_SUBTITLES_RESULT",
          ok: false,
          videoId: message.videoId,
          groups: [],
          errors: [{ message: error && error.message ? error.message : String(error) }]
        });
      });

    return true;
  }

  if (message.type === "IMMERSIVE_TRANSLATE") {
    handleImmersiveTranslate(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "IMMERSIVE_TRANSLATE_RESULT",
          ok: false,
          items: [],
          errors: [{ message: error && error.message ? error.message : String(error) }]
        });
      });

    return true;
  }

  return false;
});

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function handleSegmentSubtitles(message) {
  const settings = await storageGet(Core.DEFAULT_SETTINGS);
  const sourceLanguage = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
  const translationConfig = Core.resolveTranslationConfig(settings);
  const cues = (Array.isArray(message.cues) ? message.cues : [])
    .map((cue) => ({
      id: cue && cue.id != null ? String(cue.id) : "",
      sourceText: Core.normalizeSubtitleText(cue && cue.sourceText),
      startMs: Number(cue && cue.startMs),
      endMs: Number(cue && cue.endMs)
    }))
    .filter((cue) => cue.id && cue.sourceText);

  if (!settings.llmSentenceSegmentationEnabled || !cues.length) {
    return {
      type: "SEGMENT_SUBTITLES_RESULT",
      ok: true,
      videoId: message.videoId,
      groups: cues.map((cue) => ({ startId: cue.id, endId: cue.id })),
      errors: []
    };
  }

  if (!translationConfig.apiKey) {
    throw new Error(`${translationConfig.providerLabel} API Key is not configured.`);
  }

  const endpointUrl =
    translationConfig.apiStyle === "gemini"
      ? translationConfig.generateContentUrl
      : translationConfig.chatCompletionsUrl;
  if (!endpointUrl || !translationConfig.model) {
    throw new Error(`${translationConfig.providerLabel} base URL or model is not configured.`);
  }

  const inputFingerprint = Core.fingerprintText(
    cues.map((cue) => `${cue.id}:${cue.startMs}:${cue.endMs}:${cue.sourceText}`).join("|")
  );
  const cacheKey = `ytbt:segments:${Core.fingerprintText([
    message.videoId || "",
    message.trackFingerprint || "",
    inputFingerprint,
    translationConfig.provider,
    endpointUrl,
    translationConfig.model,
    sourceLanguage,
    Core.SENTENCE_SEGMENTATION_VERSION,
    settings.cacheVersion || "1"
  ].join("|"))}`;
  const cached = await storageGet({ [cacheKey]: null });
  const cachedValue = cached[cacheKey];
  if (
    cachedValue &&
    cachedValue.inputFingerprint === inputFingerprint &&
    Array.isArray(cachedValue.groups)
  ) {
    try {
      Core.applySentenceSegmentationGroups(cues, cachedValue.groups);
      return {
        type: "SEGMENT_SUBTITLES_RESULT",
        ok: true,
        videoId: message.videoId,
        groups: cachedValue.groups,
        cached: true,
        errors: []
      };
    } catch (error) {
      // Ignore malformed or stale segmentation cache and regenerate it below.
    }
  }

  const groups = await segmentSubtitleCues({
    translationConfig,
    sourceLanguage,
    cues
  });
  Core.applySentenceSegmentationGroups(cues, groups);
  await persistSentenceSegmentationCache(
    cacheKey,
    {
      kind: "sentence-segmentation",
      inputFingerprint,
      groups,
      updatedAt: Date.now(),
      provider: translationConfig.provider,
      model: translationConfig.model,
      sourceLanguage,
      version: Core.SENTENCE_SEGMENTATION_VERSION
    }
  );

  return {
    type: "SEGMENT_SUBTITLES_RESULT",
    ok: true,
    videoId: message.videoId,
    groups,
    cached: false,
    errors: []
  };
}

async function segmentSubtitleCues({ translationConfig, sourceLanguage, cues }) {
  const committedGroups = [];
  let carryCues = [];
  let cursor = 0;

  while (cursor < cues.length) {
    const nextCursor = Math.min(cues.length, cursor + SEGMENTATION_BATCH_SIZE);
    const windowCues = carryCues.concat(cues.slice(cursor, nextCursor));
    cursor = nextCursor;
    const groups = await translateWithRetry({
      translationConfig,
      targetLanguage: "",
      sourceLanguage,
      asrCorrectionEnabled: false,
      cues: windowCues,
      mode: "segmentation"
    });
    const isFinalWindow = cursor >= cues.length;

    if (isFinalWindow) {
      committedGroups.push(...groups);
      carryCues = [];
      break;
    }

    const lastGroup = groups[groups.length - 1];
    const carryStartIndex = windowCues.findIndex(
      (cue) => String(cue.id) === String(lastGroup.startId)
    );
    const carryEndIndex = windowCues.findIndex(
      (cue) => String(cue.id) === String(lastGroup.endId)
    );
    const nextCarry = windowCues.slice(carryStartIndex, carryEndIndex + 1);

    if (nextCarry.length && nextCarry.length <= MAX_SEGMENTATION_CARRY_CUES) {
      committedGroups.push(...groups.slice(0, -1));
      carryCues = nextCarry;
    } else {
      committedGroups.push(...groups);
      carryCues = [];
    }
  }

  return committedGroups;
}

async function persistSentenceSegmentationCache(cacheKey, cacheValue) {
  await storageSet({ [cacheKey]: cacheValue });
  const all = await storageGet(null);
  const entries = Object.keys(all)
    .filter((key) => key.startsWith("ytbt:segments:") && key !== cacheKey)
    .map((key) => ({
      key,
      updatedAt: Number(all[key] && all[key].updatedAt) || 0
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const staleKeys = entries
    .slice(Math.max(0, MAX_SEGMENTATION_CACHE_ENTRIES - 1))
    .map((entry) => entry.key);
  if (staleKeys.length) {
    await storageRemove(staleKeys);
  }
}

async function handleTranslateBatch(message) {
  const settings = await storageGet(Core.DEFAULT_SETTINGS);
  const targetLanguage = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
  const sourceLanguage = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
  const asrCorrectionEnabled = settings.asrCorrectionEnabled !== false;
  const llmSentenceSegmentationEnabled = settings.llmSentenceSegmentationEnabled !== false;
  const showOriginalTechnicalTerms = settings.showOriginalTechnicalTerms !== false;
  const translationConfig = Core.resolveTranslationConfig(settings);

  if (!translationConfig.apiKey) {
    return {
      type: "TRANSLATE_RESULT",
      ok: false,
      videoId: message.videoId,
      batchId: message.batchId,
      items: [],
      errors: [{ code: "missing_api_key", message: `${translationConfig.providerLabel} API Key is not configured.` }]
    };
  }

  const endpointUrl =
    translationConfig.apiStyle === "gemini"
      ? translationConfig.generateContentUrl
      : translationConfig.chatCompletionsUrl;
  if (!endpointUrl || !translationConfig.model) {
    return {
      type: "TRANSLATE_RESULT",
      ok: false,
      videoId: message.videoId,
      batchId: message.batchId,
      items: [],
      errors: [{ code: "missing_provider_config", message: `${translationConfig.providerLabel} base URL or model is not configured.` }]
    };
  }

  const cues = Array.isArray(message.cues) ? message.cues : [];
  const legacyCacheKeyParts = [
    message.videoId || "",
    message.trackFingerprint || "",
    translationConfig.provider,
    endpointUrl,
    translationConfig.model,
    targetLanguage,
    Core.MERGE_VERSION,
    settings.cacheVersion || "1"
  ];
  const correctedCacheKeyParts = legacyCacheKeyParts.slice(0, 5).concat([
    sourceLanguage,
    targetLanguage,
    "asr-correction-on",
    Core.MERGE_VERSION,
    settings.cacheVersion || "1"
  ]);
  const segmentedCacheKeyParts = legacyCacheKeyParts.slice(0, 5).concat([
    sourceLanguage,
    targetLanguage,
    asrCorrectionEnabled ? "asr-correction-on" : "asr-correction-off",
    "llm-sentence-segmentation-on",
    Core.SENTENCE_SEGMENTATION_VERSION,
    Core.MERGE_VERSION,
    settings.cacheVersion || "1"
  ]);
  const activeCacheKeyParts =
    llmSentenceSegmentationEnabled
      ? segmentedCacheKeyParts
      : asrCorrectionEnabled
        ? correctedCacheKeyParts
        : legacyCacheKeyParts;
  const cacheKey = Core.makeCacheKey(
    activeCacheKeyParts.concat(
      showOriginalTechnicalTerms
        ? "original-technical-terms-on"
        : "original-technical-terms-off"
    )
  );

  const cache = await storageGet({ [cacheKey]: { items: {}, updatedAt: 0 } });
  const cacheValue = cache[cacheKey] || { items: {} };
  const cachedItems = [];
  const missingCues = [];
  const sourceTextById = new Map();

  for (const cue of cues) {
    const id = cue && cue.id != null ? String(cue.id) : "";
    if (!id) {
      continue;
    }
    const sourceText = Core.normalizeSubtitleText(cue.sourceText || cue.displaySourceText || "");
    sourceTextById.set(id, sourceText);
    const cachedValue = cacheValue.items && cacheValue.items[id];
    const cachedText =
      typeof cachedValue === "string"
        ? cachedValue
        : cachedValue != null && typeof cachedValue === "object"
          ? cachedValue.translatedText
          : "";
    const cachedSourceFingerprint =
      cachedValue && typeof cachedValue === "object" ? cachedValue.sourceFingerprint : "";
    const sourceMatchesCache =
      !llmSentenceSegmentationEnabled ||
      cachedSourceFingerprint === Core.fingerprintText(sourceText);
    if (cachedText && sourceMatchesCache) {
      const cachedItem = { id, translatedText: cachedText, cached: true };
      if (cachedValue && typeof cachedValue === "object" && cachedValue.displaySourceText) {
        cachedItem.displaySourceText = cachedValue.displaySourceText;
      }
      cachedItems.push(cachedItem);
    } else {
      missingCues.push({
        id,
        sourceText
      });
    }
  }

  if (!missingCues.length) {
    return {
      type: "TRANSLATE_RESULT",
      ok: true,
      videoId: message.videoId,
      batchId: message.batchId,
      items: cachedItems,
      errors: []
    };
  }

  const translatedItems = await translateMissingCues({
    cacheKey,
    translationConfig,
    targetLanguage,
    sourceLanguage,
    asrCorrectionEnabled,
    showOriginalTechnicalTerms,
    cues: missingCues
  });

  const mergedCacheItems = Object.assign({}, cacheValue.items || {});
  for (const item of translatedItems) {
    if (llmSentenceSegmentationEnabled) {
      mergedCacheItems[item.id] = {
        translatedText: item.translatedText,
        displaySourceText: item.displaySourceText || "",
        sourceFingerprint: Core.fingerprintText(sourceTextById.get(String(item.id)) || "")
      };
    } else {
      mergedCacheItems[item.id] = item.displaySourceText
        ? { translatedText: item.translatedText, displaySourceText: item.displaySourceText }
        : item.translatedText;
    }
  }

  await persistTranslationCache({
    cacheKey,
    cacheValue: {
      items: mergedCacheItems,
      updatedAt: Date.now(),
      provider: translationConfig.provider,
      model: translationConfig.model,
      baseUrl: translationConfig.baseUrl,
      targetLanguage,
      sourceLanguage,
      asrCorrectionEnabled,
      llmSentenceSegmentationEnabled,
      showOriginalTechnicalTerms
    },
    addedCount: translatedItems.length,
    maxItems: Number(settings.translationCacheMaxItems) || Core.DEFAULT_CACHE_MAX_ITEMS
  });

  return {
    type: "TRANSLATE_RESULT",
    ok: true,
    videoId: message.videoId,
    batchId: message.batchId,
    items: cachedItems.concat(translatedItems),
    errors: []
  };
}

async function handleImmersiveTranslate(message) {
  const settings = await storageGet(Core.DEFAULT_SETTINGS);
  const targetLanguage = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
  const sourceLanguage = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
  const translationConfig = Core.resolveTranslationConfig(settings, "immersive");

  if (!translationConfig.apiKey) {
    return {
      type: "IMMERSIVE_TRANSLATE_RESULT",
      ok: false,
      items: [],
      errors: [{ code: "missing_api_key", message: `${translationConfig.providerLabel} API Key is not configured.` }]
    };
  }

  const endpointUrl =
    translationConfig.apiStyle === "gemini"
      ? translationConfig.generateContentUrl
      : translationConfig.chatCompletionsUrl;
  if (!endpointUrl || !translationConfig.model) {
    return {
      type: "IMMERSIVE_TRANSLATE_RESULT",
      ok: false,
      items: [],
      errors: [{ code: "missing_provider_config", message: `${translationConfig.providerLabel} base URL or model is not configured.` }]
    };
  }

  const cues = (Array.isArray(message.items) ? message.items : [])
    .map((item) => ({
      id: item && item.id != null ? String(item.id) : "",
      sourceText: Core.normalizeSubtitleText(item && item.sourceText)
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

  const translatedItems = await translateWithRetry({
    translationConfig,
    targetLanguage,
    sourceLanguage,
    asrCorrectionEnabled: false,
    cues,
    mode: "immersive"
  });

  return {
    type: "IMMERSIVE_TRANSLATE_RESULT",
    ok: true,
    items: translatedItems,
    errors: []
  };
}

function inFlightCueKey(cacheKey, cueId, sourceText) {
  return `${cacheKey}:${cueId}:${Core.fingerprintText(sourceText || "")}`;
}

async function translateMissingCues(request) {
  const pendingCues = [];
  const sharedPromises = [];

  for (const cue of request.cues) {
    const key = inFlightCueKey(request.cacheKey, cue.id, cue.sourceText);
    const existing = inFlightCueTranslations.get(key);
    if (existing) {
      sharedPromises.push(existing);
    } else {
      pendingCues.push(cue);
    }
  }

  let newItems = [];
  if (pendingCues.length) {
    const batchPromise = translateWithRetry(Object.assign({}, request, { cues: pendingCues }));
    for (const cue of pendingCues) {
      const key = inFlightCueKey(request.cacheKey, cue.id, cue.sourceText);
      const itemPromise = batchPromise.then((items) => {
        return items.find((entry) => String(entry.id) === String(cue.id)) || null;
      });
      inFlightCueTranslations.set(key, itemPromise);
      itemPromise.finally(() => {
        if (inFlightCueTranslations.get(key) === itemPromise) {
          inFlightCueTranslations.delete(key);
        }
      }).catch(() => {});
      sharedPromises.push(itemPromise);
    }
    newItems = await batchPromise;
  }

  const settledSharedItems = sharedPromises.length ? await Promise.allSettled(sharedPromises) : [];
  const sharedItems = [];
  let firstSharedError = null;
  for (const result of settledSharedItems) {
    if (result.status === "fulfilled") {
      if (result.value) {
        sharedItems.push(result.value);
      }
    } else if (!firstSharedError) {
      firstSharedError = result.reason;
    }
  }

  const itemsById = new Map();
  for (const item of newItems.concat(sharedItems)) {
    if (item && item.id != null && item.translatedText) {
      itemsById.set(String(item.id), item);
    }
  }
  if (!itemsById.size && firstSharedError) {
    throw firstSharedError;
  }
  return Array.from(itemsById.values());
}

async function translateWithRetry(request) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await translateBatch(request);
    } catch (error) {
      lastError = error;
      const message = (error && error.message) || String(error);
      if (isTruncationError(message)) {
        throw error;
      }
      // Fatal / unknown errors (bad config, auth, quota, unparseable shapes)
      // should not waste retry budget; only retry transient failures.
      if (Core.classifyTranslationError(message) !== "retryable") {
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        const retryDelayMs = retryDelayForError(message, request.translationConfig, attempt);
        if (!retryDelayMs) {
          throw error;
        }
        await delay(retryDelayMs);
      }
    }
  }
  throw lastError;
}

function isTruncationError(message) {
  return /truncated|finish_reason=(?:length|MAX_TOKENS)|MAX_TOKENS/i.test(String(message || ""));
}

function retryDelayForError(message, translationConfig, attempt) {
  const text = String(message || "");
  if (translationConfig && translationConfig.apiStyle === "gemini") {
    if (/429|TooManyRequests|too many requests|rate limit/i.test(text)) {
      return 0;
    }
    if (/503|ServiceUnavailable|unavailable/i.test(text)) {
      return 8000 * Math.pow(2, attempt);
    }
  }

  const base = /429|rate limit|too many requests/i.test(text) ? 15000 : 500;
  return base * Math.pow(2, attempt);
}

async function translateBatch({
  translationConfig,
  sourceLanguage,
  targetLanguage,
  asrCorrectionEnabled,
  showOriginalTechnicalTerms,
  cues,
  mode
}) {
  const sourceLabel = Core.sourceLanguageLabel(sourceLanguage);
  const targetLabel = Core.targetLanguageLabel(targetLanguage);
  // Allow roughly 200 output tokens per cue so longer batches are not silently
  // truncated. Bounded to a sane [2048, 8000] range.
  const sourceCharCount = cues.reduce((total, cue) => total + String(cue.sourceText || "").length, 0);
  const maxTokens = Math.min(8000, Math.max(2048, cues.length * 220, Math.ceil(sourceCharCount * 1.25)));
  const sourcePolishInstruction = asrCorrectionEnabled
    ? "Before translating, correct only obvious ASR recognition mistakes in the source using nearby batch context: wrong homophones, broken word boundaries, missing small words, and clear recognition errors. Preserve technical terms, names, code identifiers, acronyms, numbers, and uncertain words exactly when unsure. "
    : "Do not rewrite the source words for ASR correction; only restore natural punctuation and capitalization. ";
  const cueBoundaryInstruction =
    "Each input id is already a locally merged subtitle cue. Use nearby batch context only to understand meaning, but do not merge text across ids or make multiple ids return the same full sentence. Keep one distinct `translatedText` for each input id. ";
  const terminologyInstruction = Core.buildTechnicalTerminologyInstruction(
    showOriginalTechnicalTerms
  );
  const outputInstruction =
    "Return exactly one item for every input id and never skip ids. " +
    "Output strict valid JSON only, with no markdown and no extra fields. Escape all quotes and backslashes inside strings. Exact format: " +
    "{\"items\":[{\"id\":\"0\",\"translatedText\":\"...\"}]}.";
  const segmentationInstruction =
    `You are a ${sourceLabel} subtitle sentence-boundary engine. Group adjacent input cues into natural, complete spoken sentences before translation. ` +
    "An input cue may end in the middle of a sentence and the next cue may complete it; merge those cues into one group. " +
    "Never translate, summarize, reorder, invent, or delete words, and never split one input id across groups. " +
    "Every input id must be covered exactly once, in the original order, using consecutive startId/endId ranges. " +
    "Prefer one complete sentence per group. When an input id already contains multiple sentences, keep them together. " +
    "In displaySourceText, concatenate the covered source text and only restore natural punctuation and capitalization. " +
    "Output strict valid JSON only, with no markdown. Exact format: " +
    "{\"groups\":[{\"startId\":\"0\",\"endId\":\"1\",\"displaySourceText\":\"Complete sentence.\"}]}.";
  const systemPrompt =
    mode === "segmentation"
      ? segmentationInstruction
      : mode === "immersive"
        ? `You are an immersive webpage translation engine. Translate ${sourceLabel} webpage text into natural ${targetLabel}. ` +
          "Do not summarize, omit, merge, or split items. Preserve URLs, code identifiers, numbers, names, product names, and formatting-sensitive symbols. " +
          "Keep the translation faithful and readable as a bilingual paragraph shown under the original text. " +
          outputInstruction
        : `You are a subtitle translation engine. Translate ${sourceLabel} subtitles into natural ${targetLabel}. ` +
          sourcePolishInstruction +
          cueBoundaryInstruction +
          terminologyInstruction +
          "Keep meaning concise for on-screen reading. `translatedText` must translate the polished meaning. " +
          outputInstruction;
  const userPayload = {
    items: cues.map((cue) => ({ id: String(cue.id), text: cue.sourceText }))
  };

  let content = "";
  let finishReason = "";

  if (translationConfig.apiStyle === "gemini") {
    const payload = {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(userPayload) }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: maxTokens
      }
    };

    if (translationConfig.useJsonResponseFormat) {
      payload.generationConfig.responseMimeType = "application/json";
    }

    const response = await fetchWithTimeout(
      withApiKeyQuery(translationConfig.generateContentUrl, translationConfig.apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatProviderRequestError(translationConfig.providerLabel, response.status, bodyText));
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      throw new Error(`${translationConfig.providerLabel} returned non-JSON response.`);
    }

    const candidate = body && body.candidates && body.candidates[0];
    finishReason = candidate && candidate.finishReason;
    content = extractGeminiCandidateText(candidate);
    if (!content && body && body.promptFeedback && body.promptFeedback.blockReason) {
      throw new Error(`${translationConfig.providerLabel} returned empty content (${body.promptFeedback.blockReason}).`);
    } else if (!content && finishReason) {
      throw new Error(`${translationConfig.providerLabel} returned empty content (finish_reason=${finishReason}).`);
    }
  } else {
    const payload = {
      model: translationConfig.model,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify(userPayload)
        }
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: maxTokens
    };

    if (translationConfig.useJsonResponseFormat) {
      payload.response_format = { type: "json_object" };
    }
    if (translationConfig.includeDeepSeekThinkingFlag) {
      payload.thinking = { type: "disabled" };
    }

    const response = await fetchWithTimeout(translationConfig.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${translationConfig.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatProviderRequestError(translationConfig.providerLabel, response.status, bodyText));
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      throw new Error(`${translationConfig.providerLabel} returned non-JSON response.`);
    }

    const choice = body && body.choices && body.choices[0];
    content =
      choice &&
      choice.message &&
      choice.message.content;
    finishReason = choice && choice.finish_reason;
  }

  if (!content) {
    throw new Error(`${translationConfig.providerLabel} returned empty content.`);
  }

  // Detect token-limit truncation so the caller can shrink the batch and retry,
  // instead of silently dropping cues and entering per-cue retry loops.
  if (finishReason === "length" || finishReason === "MAX_TOKENS") {
    throw new Error(
      `${translationConfig.providerLabel} response truncated (finish_reason=${finishReason}); split batch in content.`
    );
  }

  if (mode === "segmentation") {
    return Core.parseSentenceSegmentationContent(content, cues);
  }

  const items = Core.parseDeepSeekTranslationContent(content);
  const expectedIds = new Set(cues.map((cue) => String(cue.id)));
  const filtered = items.filter((item) => expectedIds.has(String(item.id)));

  if (!filtered.length) {
    throw new Error(`${translationConfig.providerLabel} response did not contain usable translations.`);
  }

  return filtered;
}

function withApiKeyQuery(url, apiKey) {
  const separator = String(url || "").includes("?") ? "&" : "?";
  return `${url}${separator}key=${encodeURIComponent(apiKey)}`;
}

function formatProviderRequestError(providerLabel, status, bodyText) {
  const detail = extractProviderErrorMessage(bodyText);
  return `${providerLabel} request failed (${status}): ${detail}`;
}

function extractProviderErrorMessage(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) {
    return "empty error response";
  }

  try {
    const body = JSON.parse(text);
    const error = body && body.error;
    if (error && typeof error.message === "string") {
      return error.message.slice(0, 300);
    }
    if (error && typeof error.status === "string") {
      return error.status.slice(0, 300);
    }
    if (body && body.promptFeedback && body.promptFeedback.blockReason) {
      return String(body.promptFeedback.blockReason).slice(0, 300);
    }
  } catch (error) {
    // Fall back to the raw text below.
  }

  return text.slice(0, 300);
}

function extractGeminiCandidateText(candidate) {
  const parts =
    candidate &&
    candidate.content &&
    Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => {
    clearTimeout(timeout);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Write a video's translation cache back, evicting least-recently-updated video
// keys when the total cached-cue count would exceed the configured ceiling.
// Eviction granularity is per video (each `ytbt:` key), matching the natural
// "least recently watched video" semantics.
async function persistTranslationCache({ cacheKey, cacheValue, addedCount, maxItems }) {
  const latest = await storageGet({ [cacheKey]: { items: {}, updatedAt: 0 } });
  const latestValue = latest[cacheKey] || { items: {}, updatedAt: 0 };
  const latestItems = latestValue.items && typeof latestValue.items === "object" ? latestValue.items : {};
  const incomingItems = cacheValue.items && typeof cacheValue.items === "object" ? cacheValue.items : {};
  const actualAddedCount = Object.keys(incomingItems).filter((key) => !latestItems[key]).length;
  cacheValue = Object.assign({}, latestValue, cacheValue, {
    items: Object.assign({}, latestItems, incomingItems),
    updatedAt: Date.now()
  });
  addedCount = actualAddedCount;

  // Lazily initialize the in-memory count once per service-worker lifetime.
  if (cachedItemCount == null) {
    cachedItemCount = await countCachedTranslationItems();
  }

  cachedItemCount += addedCount;

  if (cachedItemCount > maxItems) {
    const evicted = await evictOldestCacheKeys(cachedItemCount - maxItems, cacheKey);
    cachedItemCount -= evicted.freedItems;
  }

  try {
    await storageSet({ [cacheKey]: cacheValue });
  } catch (error) {
    // The in-memory count may have drifted (e.g. external clears). On a write
    // failure, recompute from storage and retry the eviction once before giving up.
    cachedItemCount = await countCachedTranslationItems();
    if (cachedItemCount > maxItems) {
      const evicted = await evictOldestCacheKeys(cachedItemCount - maxItems, cacheKey);
      cachedItemCount -= evicted.freedItems;
    }
    await storageSet({ [cacheKey]: cacheValue });
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
