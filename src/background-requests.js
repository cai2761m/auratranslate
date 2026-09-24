// In-flight deduplication, provider requests, and timeout policy.
// Classic scripts share the dedicated background scope; background.js loads them
// synchronously in Chrome, and manifest.json supplies the same order in Firefox.
function inFlightCueKey(cacheKey, cueId, sourceText) {
  return `${cacheKey}:${cueId}:${Core.fingerprintText(sourceText || "")}`;
}

async function translateMissingCues(request) {
  const pendingCues = [];
  const retainedItems = [];
  const ownedCues = [];
  const sharedPromises = [];

  for (const cue of request.cues) {
    const key = inFlightCueKey(request.cacheKey, cue.id, cue.sourceText);
    const existing = inFlightCueTranslations.get(key);
    if (existing) {
      sharedPromises.push(existing);
    } else {
      ownedCues.push(cue);
      const completed = completedCueTranslations.get(key);
      if (completed) retainedItems.push(completed);
      else pendingCues.push(cue);
    }
  }

  if (ownedCues.length) {
    const batchPromise = (async () => {
      const retain = async (items) => {
        for (const item of items) {
          const cue = pendingCues.find((entry) => String(entry.id) === String(item.id));
          if (cue) completedCueTranslations.set(inFlightCueKey(request.cacheKey, cue.id, cue.sourceText), item);
        }
        await request.persistItems(items);
      };
      const newItems = pendingCues.length
        ? await (request.translateCues || translateWithRetry)(Object.assign({}, request, { cues: pendingCues }), retain)
        : [];
      for (const item of newItems) {
        const cue = pendingCues.find((entry) => String(entry.id) === String(item.id));
        if (cue) {
          completedCueTranslations.set(inFlightCueKey(request.cacheKey, cue.id, cue.sourceText), item);
        }
      }
      const items = retainedItems.concat(newItems);
      // A refresh must keep sharing this result until it is durably stored.
      // If storage fails, the retained result lets a retry save it without
      // making another paid provider request.
      await request.persistItems(items);
      while (completedCueTranslations.size > Core.DEFAULT_CACHE_MAX_ITEMS) {
        completedCueTranslations.delete(completedCueTranslations.keys().next().value);
      }
      return items;
    })();
    for (const cue of ownedCues) {
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
  for (const item of sharedItems) {
    if (item && item.id != null && item.translatedText) {
      itemsById.set(String(item.id), item);
    }
  }
  if (firstSharedError) {
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
      // An interrupted response may already have been billed. Do not replay it.
      if (error.requestMayHaveReachedProvider) throw error;
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
          "Preserve every paired [[YTBT_TAG_N]] and [[/YTBT_TAG_N]] formatting marker exactly once, with correct nesting, around the corresponding translated words; markers may move with those words. Translate text inside emphasis and link markers, but keep text inside CODE, KBD and SAMP markers unchanged. Keep BR marker pairs empty. Do not add HTML or Markdown formatting. " +
          "Keep the translation faithful and readable as a bilingual paragraph shown under the original text. " +
          outputInstruction
        : `You are a subtitle translation engine. Translate ${sourceLabel} subtitles into natural ${targetLabel}. ` +
          sourcePolishInstruction +
          cueBoundaryInstruction +
          terminologyInstruction +
          "Keep meaning concise for on-screen reading. `translatedText` must translate the polished meaning. " +
          outputInstruction;
  // Content hashes belong in local cache identities, not in model output:
  // short wire IDs avoid spending generation time/tokens copying SHA-256 IDs.
  const wireCues = mode === "immersive"
    ? cues.map((cue, index) => ({ ...cue, id: String(index) }))
    : cues;
  const userPayload = {
    items: wireCues.map((cue) => ({ id: String(cue.id), text: cue.sourceText }))
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

    const { response, bodyText } = await fetchWithTimeout(
      withApiKeyQuery(translationConfig.generateContentUrl, translationConfig.apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

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

    const { response, bodyText } = await fetchWithTimeout(translationConfig.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${translationConfig.apiKey}`
      },
      body: JSON.stringify(payload)
    });

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
  const expectedIds = new Set(wireCues.map((cue) => String(cue.id)));
  const filtered = items.filter((item) => expectedIds.has(String(item.id)));

  if (!filtered.length) {
    throw new Error(`${translationConfig.providerLabel} response did not contain usable translations.`);
  }

  return mode === "immersive"
    ? filtered.map((item) => ({ ...item, id: String(cues[Number(item.id)].id) }))
    : filtered;
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

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS, potentiallyBilled = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    // fetch resolves at response headers; the body may still stall indefinitely.
    const bodyText = await response.text();
    return { response, bodyText };
  } catch (error) {
    if (controller.signal.aborted) {
      const failure = new Error(potentiallyBilled
        ? "翻译接口响应超时，请稍后查看缓存或手动重试；请求可能已经计费。"
        : "Google 免 Key 接口响应超时，请稍后手动重试。");
      failure.requestMayHaveReachedProvider = potentiallyBilled;
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
