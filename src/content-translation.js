/*
 * AuraTranslate content script — translation queue, batching, and backoff
 *
 * The src/content-*.js files are separate classic scripts that the browser evaluates
 * in one shared isolated-world scope, so top-level declarations here are visible to the
 * other content-*.js files. manifest.json fixes the load order:
 *   content-core -> content-captions -> content-translation -> content-player
 *   -> content-overlay -> content-main
 * Keep top-level names unique across these files, and declare shared bindings with
 * `var` (never `const`/`let`) so a re-injection cannot fail with a redeclaration error.
 */
"use strict";

// --- Queue scheduling and batch dispatch ---
function scheduleTranslations(anchorMs, resetQueue) {
  if (!state.settings.subtitleEnabled || !state.cues.length || state.preparationBlocked) {
    return;
  }

  if (!hasApiKey()) {
    setStatus(`${missingApiConfigText()}。`);
    return;
  }

  ensureCaptionPreparation();
  if (resetQueue || state.settings.subtitleTranslationMode !== "full") {
    state.queue = [];
  }

  const alreadyQueued = new Set();
  for (const batch of state.queue) {
    for (const cue of batch.cues) {
      alreadyQueued.add(cue.id);
    }
  }
  for (const batch of state.inFlight.values()) {
    for (const cue of batch.cues) {
      alreadyQueued.add(cue.id);
    }
  }

  const pending = state.cues
    .filter((cue) => cue.status === "pending" && !alreadyQueued.has(cue.id) && isCueInTranslationWindow(cue, anchorMs))
    .sort((left, right) => priorityScore(left, anchorMs) - priorityScore(right, anchorMs));

  const batchSize = currentBatchSize();
  for (let index = 0; index < pending.length; index += batchSize) {
    state.queue.push({ cues: pending.slice(index, index + batchSize) });
  }

  pumpQueue();
}

function isCueInTranslationWindow(cue, anchorMs) {
  if (state.settings.subtitleTranslationMode === "full") return true;
  const minutes = [1, 2, 3].includes(Number(state.settings.subtitleLookAheadMinutes))
    ? Number(state.settings.subtitleLookAheadMinutes) : 2;
  return cue.endMs > anchorMs && cue.startMs < anchorMs + minutes * 60000;
}

function priorityScore(cue, anchorMs) {
  if (cue.endMs >= anchorMs && cue.startMs <= anchorMs + PRIORITY_WINDOW_MS) {
    return Math.abs(cue.startMs - anchorMs);
  }
  if (cue.startMs > anchorMs + PRIORITY_WINDOW_MS) {
    return PRIORITY_WINDOW_MS + cue.startMs - anchorMs;
  }
  return PRIORITY_WINDOW_MS * 10 + (anchorMs - cue.endMs);
}

function pumpQueue() {
  if (state.pumping || state.preparationBlocked || !state.settings.subtitleEnabled || !hasApiKey()) {
    return;
  }

  if (isInApiBackoff()) {
    scheduleApiBackoffTimer();
    setStatus(formatApiBackoffStatus());
    return;
  }

  state.pumping = true;
  try {
    while (state.inFlight.size < currentMaxParallelBatches() && state.queue.length) {
      const queued = state.queue.shift();
      const cues = queued.cues.filter((cue) => cue.status === "pending" && isCueInTranslationWindow(cue, getCurrentTimeMs()));
      if (!cues.length) {
        continue;
      }

      const batch = {
        id: `${state.videoId}:${state.trackFingerprint}:${Date.now()}:${state.batchSerial += 1}`,
        videoId: state.videoId,
        trackFingerprint: state.trackFingerprint,
        translationTrackFingerprint: state.translationTrackFingerprint,
        cues
      };

      for (const cue of cues) {
        cue.status = "translating";
      }

      state.inFlight.set(batch.id, batch);
      sendTranslationBatch(batch);
    }
    updateProgressStatus();
  } finally {
    state.pumping = false;
  }
}

async function sendTranslationBatch(batch) {
  try {
    const response = await sendMessage({
      type: "TRANSLATE_BATCH",
      batchId: batch.id,
      videoId: batch.videoId,
      trackFingerprint: batch.translationTrackFingerprint || batch.trackFingerprint,
      cues: batch.cues.map((cue) => ({
        id: cue.id,
        sourceText: cue.sourceText
      }))
    });

    const currentBatch = state.inFlight.get(batch.id);
    state.inFlight.delete(batch.id);

    if (!currentBatch || currentBatch.videoId !== state.videoId || currentBatch.trackFingerprint !== state.trackFingerprint) {
      pumpQueue();
      return;
    }

    if (!response || response.ok === false) {
      const error = response && response.errors && response.errors[0];
      const message = error && error.message ? error.message : "翻译失败";
      if (splitBatchOnTruncation(currentBatch, message)) {
        // Cues already re-queued in smaller batches; skip per-cue retry path.
      } else {
        handleBatchFailure(currentBatch, message);
      }
    } else {
      applyTranslations(currentBatch, response.items || []);
    }
  } catch (error) {
    const currentBatch = state.inFlight.get(batch.id);
    state.inFlight.delete(batch.id);

    if (!currentBatch || currentBatch.videoId !== state.videoId || currentBatch.trackFingerprint !== state.trackFingerprint) {
      pumpQueue();
      return;
    }

    const message = error.message || String(error);
    if (splitBatchOnTruncation(currentBatch, message)) {
      // Cues already re-queued in smaller batches; skip per-cue retry path.
    } else {
      handleBatchFailure(currentBatch, message);
    }
  }

  updateProgressStatus();
  pumpQueue();
}

function sendMessage(message, timeoutMs) {
  return Core.sendRuntimeMessage(chrome.runtime, message, timeoutMs || TRANSLATION_MESSAGE_TIMEOUT_MS);
}

function applyTranslations(batch, items) {
  const translatedById = new Map();
  for (const item of items) {
    if (item && item.id != null && item.translatedText) {
      translatedById.set(String(item.id), {
        translatedText: Core.normalizeSubtitleText(item.translatedText),
        displaySourceText: Core.normalizeSubtitleText(item.displaySourceText || "")
      });
    }
  }

  for (const cue of batch.cues) {
    const translation = translatedById.get(String(cue.id));
    if (translation && translation.translatedText) {
      if (translation.displaySourceText) {
        cue.displaySourceText = translation.displaySourceText;
      }
      cue.translatedText = translation.translatedText;
      cue.status = "translated";
      cue.translationRetryCount = 0;
    } else {
      queueCueTranslationRetry(cue, "Translation API did not return this cue.");
    }
  }
}

function handleBatchFailure(batch, message) {
  const retryable = isRetryableTranslationError(message);
  const backoffMs = retryable ? apiBackoffMsForError(message) : 0;

  if (backoffMs && requeueBatchForBackoff(batch, message)) {
    applyApiBackoff(message, backoffMs);
    return;
  }

  for (const cue of batch.cues) {
    if (cue.status === "translating") {
      if (retryable && queueCueTranslationRetry(cue, message)) {
        continue;
      }
      cue.status = "failed";
      cue.lastError = message;
    }
  }
  setStatus(message.includes("API Key") ? `${missingApiConfigText()}。` : `翻译失败：${message}`);
}

function queueCueTranslationRetry(cue, message) {
  cue.translationRetryCount = Number(cue.translationRetryCount || 0) + 1;
  cue.lastError = message;

  if (cue.translationRetryCount > MAX_CUE_TRANSLATION_RETRIES) {
    cue.status = "failed";
    return false;
  }

  cue.status = "pending";
  enqueueRetryCues([cue]);
  return true;
}

function enqueueRetryCues(cues) {
  const retryCues = cues.filter((cue) => cue && cue.status === "pending");
  const retryBatchSize = currentRetryBatchSize();
  for (let index = retryCues.length; index > 0; index -= retryBatchSize) {
    const start = Math.max(0, index - retryBatchSize);
    state.queue.unshift({ cues: retryCues.slice(start, index) });
  }
}

function isRetryableTranslationError(message) {
  return Core.classifyTranslationError(message) === "retryable";
}

function currentTranslationConfig() {
  return Core.resolveTranslationConfig(state.settings);
}

function isGeminiProvider() {
  return currentTranslationConfig().apiStyle === "gemini";
}

function isCustomOpenAiProvider() {
  return currentTranslationConfig().provider === "custom";
}

function currentBatchSize() {
  if (isGeminiProvider()) {
    return GEMINI_BATCH_SIZE;
  }
  return isCustomOpenAiProvider() ? CUSTOM_BATCH_SIZE : BATCH_SIZE;
}

function currentRetryBatchSize() {
  if (isGeminiProvider()) {
    return GEMINI_RETRY_BATCH_SIZE;
  }
  return isCustomOpenAiProvider() ? CUSTOM_RETRY_BATCH_SIZE : RETRY_BATCH_SIZE;
}

function currentMaxParallelBatches() {
  if (isGeminiProvider()) {
    return GEMINI_MAX_PARALLEL_BATCHES;
  }
  return isCustomOpenAiProvider() ? CUSTOM_MAX_PARALLEL_BATCHES : MAX_PARALLEL_BATCHES;
}

function requeueBatchForBackoff(batch, message) {
  const eligible = [];
  for (const cue of batch.cues) {
    if (cue.status === "translating") {
      cue.lastError = message;
      cue.status = "pending";
      eligible.push(cue);
    }
  }
  if (!eligible.length) {
    return false;
  }
  enqueueRetryCues(eligible);
  return true;
}

function apiBackoffMsForError(message) {
  const text = String(message || "");
  if (/429|TooManyRequests|too many requests|rate limit/i.test(text)) {
    return RATE_LIMIT_BACKOFF_MS;
  }
  if (/503|ServiceUnavailable|unavailable/i.test(text)) {
    return SERVICE_BACKOFF_MS;
  }
  if (/timeout|aborted|network|failed to fetch/i.test(text)) {
    return DEFAULT_API_BACKOFF_MS;
  }
  return 0;
}

function applyApiBackoff(message, backoffMs) {
  state.apiBackoffUntil = Math.max(state.apiBackoffUntil || 0, Date.now() + backoffMs);
  state.apiBackoffMessage = simplifyTranslationError(message);
  scheduleApiBackoffTimer();
  setStatus(formatApiBackoffStatus());
}

function isInApiBackoff() {
  return state.apiBackoffUntil && Date.now() < state.apiBackoffUntil;
}

function scheduleApiBackoffTimer() {
  if (state.apiBackoffTimer) {
    clearTimeout(state.apiBackoffTimer);
  }

  const remainingMs = Math.max(0, (state.apiBackoffUntil || 0) - Date.now());
  if (!remainingMs) {
    state.apiBackoffUntil = 0;
    state.apiBackoffMessage = "";
    state.apiBackoffTimer = null;
    return;
  }

  state.apiBackoffTimer = setTimeout(() => {
    state.apiBackoffTimer = null;
    if (isInApiBackoff()) {
      scheduleApiBackoffTimer();
      setStatus(formatApiBackoffStatus());
      return;
    }
    state.apiBackoffUntil = 0;
    state.apiBackoffMessage = "";
    updateProgressStatus();
    scheduleTranslations(getCurrentTimeMs(), true);
  }, Math.min(remainingMs, 60000));
}

function formatApiBackoffStatus() {
  const seconds = Math.max(1, Math.ceil(((state.apiBackoffUntil || 0) - Date.now()) / 1000));
  const detail = state.apiBackoffMessage ? `：${state.apiBackoffMessage}` : "";
  return `API 请求过快，暂停 ${seconds} 秒后自动重试${detail}`;
}

// When the upstream model truncates a batch (finish_reason=length), re-queue
// the affected cues in much smaller chunks (RETRY_BATCH_SIZE) so the next
// attempt fits within the token budget, instead of retrying the same oversized
// batch and looping. Returns true when the split was applied.
function splitBatchOnTruncation(batch, message) {
  if (!/truncated|finish_reason|MAX_TOKENS/i.test(String(message || ""))) {
    return false;
  }
  const eligible = [];
  for (const cue of batch.cues) {
    if (cue.status === "translating") {
      cue.translationRetryCount = Number(cue.translationRetryCount || 0);
      cue.status = "pending";
      eligible.push(cue);
    }
  }
  if (!eligible.length) {
    return false;
  }
  enqueueRetryCues(eligible);
  return true;
}

function updateProgressStatus() {
  if (!state.cues.length || state.preparationBlocked) {
    return;
  }

  const done = state.cues.filter((cue) => cue.status === "translated").length;
  const failed = state.cues.filter((cue) => cue.status === "failed").length;
  const translating = state.cues.filter((cue) => cue.status === "translating").length;
  const total = state.cues.length;

  if (done === total) {
    setStatus("");
  } else if (failed) {
    const failedCue = state.cues.find((cue) => cue.status === "failed" && cue.lastError);
    const detail = failedCue ? `：${simplifyTranslationError(failedCue.lastError)}` : "";
    setStatus(`部分字幕翻译失败，已完成 ${done}/${total}，失败 ${failed}${detail}`);
  } else if (translating) {
    setStatus(`正在翻译字幕 ${done}/${total}（${translating} 条处理中）...`);
  } else if (state.settings.subtitleTranslationMode !== "full" &&
      !state.cues.some((cue) => cue.status !== "translated" && isCueInTranslationWindow(cue, getCurrentTimeMs()))) {
    setStatus(`省 token 模式：附近字幕已就绪，随播放继续翻译（已完成 ${done} 条）。`);
  } else {
    setStatus(`正在预翻译字幕 ${done}/${total}...`);
  }
}

function hasApiKey() {
  const config = Core.resolveTranslationConfig(state.settings);
  const endpointUrl =
    config.apiStyle === "gemini"
      ? config.generateContentUrl
      : config.chatCompletionsUrl;
  return Boolean(config.apiKey && endpointUrl && config.model);
}
