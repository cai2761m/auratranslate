// Viewport scheduling, cache recovery, and translation messaging.
// Modules share only YTBTImmersive; startup runs last in immersive.js.
(function () {
  "use strict";
  const App = globalThis.YTBTImmersive;
  if (!App) return;
  const { Core, state } = App;

  const BATCH_SIZE = 8;
  const FIRST_BATCH_SIZE = 4;
  const VISIBLE_BATCH_CHAR_LIMIT = 1800;
  const MAX_CONCURRENT_BATCHES = 3;
  // Three 60s provider attempts plus up to 45s of retry backoff and persistence.
  const MESSAGE_TIMEOUT_MS = 240000;
  const CACHE_MESSAGE_TIMEOUT_MS = 15000;
  const CACHE_POLL_INTERVAL_MS = 5000;
  const MAX_RECOVERY_POLLS = 12;
  function syncPageIdentity() {
    const url = App.pageIdentity();
    if (state.pageUrl === url) return;
    state.pageUrl = url;
    state.runToken += 1;
    clearRecovery();
    state.translated = false;
    App.clearExistingTranslations();
    App.updateBallMode("idle");
    App.showStatus(null);
    window.dispatchEvent(new Event("ytbt-page-changed"));
    setTimeout(App.maybeAutoTranslate, 0);
  }

  function isCurrentRun(token, pageUrl) {
    syncPageIdentity();
    return token === state.runToken && pageUrl === state.pageUrl;
  }

  async function waitForVisiblePage(token, pageUrl) {
    if (!document.hidden || !isCurrentRun(token, pageUrl)) return;
    await new Promise((resolve) => {
      const resume = () => {
        if (document.hidden && isCurrentRun(token, pageUrl)) return;
        document.removeEventListener("visibilitychange", resume);
        window.removeEventListener("pageshow", resume);
        window.removeEventListener("ytbt-page-changed", resume);
        resolve();
      };
      document.addEventListener("visibilitychange", resume);
      window.addEventListener("pageshow", resume);
      window.addEventListener("ytbt-page-changed", resume);
    });
  }

  function isUncertainRequest(error) {
    return /background did not respond|message (?:port|channel) closed|未返回结果|翻译接口响应超时/i.test(error && error.message || error);
  }

  function clearRecovery() {
    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
    state.recovery = null;
  }

  function scheduleRecovery(recovery) {
    if (!recovery || recovery !== state.recovery || document.hidden || recovery.polls >= MAX_RECOVERY_POLLS) return;
    // Unsent paragraphs cannot appear in the cache as a result of this run.
    // Only keep polling while a delivered request may still complete.
    if (!recovery.blocks.some((block) => block.element.isConnected && block.container.dataset.ytbtState === "waiting")) return;
    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = setTimeout(recoverCachedTranslations, CACHE_POLL_INTERVAL_MS);
  }

  async function recoverCachedTranslations() {
    const recovery = state.recovery;
    if (!recovery || state.recovering || document.hidden || !isCurrentRun(recovery.token, recovery.pageUrl)) return;
    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
    state.recovering = true;
    recovery.polls += 1;
    try {
      const pending = recovery.blocks.filter((block) => block.element.isConnected && block.container.dataset.ytbtState !== "done");
      const items = await translateBatch(pending, true, recovery.pageUrl);
      if (!isCurrentRun(recovery.token, recovery.pageUrl) || recovery !== state.recovery) return;
      const byId = new Map(items.map((item) => [String(item.id), item.translatedText]));
      for (const block of pending) {
        if (byId.get(block.id)) App.renderTranslation(block, byId.get(block.id));
      }
      const remaining = recovery.blocks.filter((block) => block.element.isConnected && block.container.dataset.ytbtState !== "done").length;
      if (!remaining) {
        clearRecovery();
        state.translated = true;
        App.updateBallMode("done");
        App.showStatus("已从缓存恢复全部译文，没有重新请求翻译。");
      } else {
        const waiting = pending.some((block) => block.container.dataset.ytbtState === "waiting");
        App.showStatus(`已保留完成的译文，还有 ${remaining} 段未完成。${waiting && recovery.polls < MAX_RECOVERY_POLLS ? "正在自动检查晚到的译文；" : ""}点击翻译按钮可手动继续。`, true);
      }
    } catch (_) {
      // A failed read must never become a paid retry. Keep recovery available
      // for the next pageshow/visibility event or an explicit user click.
      if (isCurrentRun(recovery.token, recovery.pageUrl) && recovery === state.recovery) {
        App.showStatus("暂时无法读取译文缓存。请稍后切回页面，或刷新后点击翻译按钮。", true);
      }
    } finally {
      state.recovering = false;
      scheduleRecovery(state.recovery);
    }
  }

  async function translateCurrentPage() {
    if (state.mode === "translating") return;
    App.updateBallMode("translating");
    await state.preferencesReady;
    syncPageIdentity();
    state.runPreferences = { ...state.preferences };
    const pageUrl = state.pageUrl;
    clearRecovery();
    App.clearExistingTranslations();
    state.translated = false;
    const blocks = App.collectBlocks();
    if (!blocks.length) {
      App.updateBallMode("idle");
      App.showStatus("当前页面没有找到可翻译的正文。");
      return;
    }

    const token = (state.runToken += 1);
    // A superseded run must not write progress onto the new page's control.
    state.panelStatusText = "";
    state.panelStatusPersistent = false;
    state.translated = false;
    state.visible = true;
    document.documentElement.classList.remove("ytbt-immersive-hidden");
    App.updateBallMode("translating");
    App.showStatus(`Translating 0/${blocks.length} blocks...`, true);

    for (const block of blocks) {
      block.container = App.createTranslationContainer(block);
    }

    let translatedCount = 0;
    try {
      const applyItems = (batch, items) => {
        // Navigation can invalidate the run while a response is in flight; a
        // stale progress write would otherwise resurface on the new page.
        if (!isCurrentRun(token, pageUrl)) return [];
        const translatedById = new Map(items.filter((item) => item && item.translatedText)
          .map((item) => [String(item.id), Core.normalizeSubtitleText(item.translatedText)]));
        const missing = [];
        for (const block of batch) {
          // Cache progress may have rendered this block before the original
          // response arrives. Never count it twice or mark it missing again.
          if (block.container.dataset.ytbtState === "done") continue;
          const translatedText = translatedById.get(block.id);
          if (translatedText) {
            App.renderTranslation(block, translatedText);
            translatedCount += 1;
          } else {
            missing.push(block);
          }
        }
        App.showStatus(`Translating ${translatedCount}/${blocks.length} blocks...`, true);
        return missing;
      };

      // Hydrate the whole page first so cached paragraphs never wait behind a
      // slow provider request. A cache read failure must not trigger paid work.
      const cachedItems = await translateBatch(blocks, true, pageUrl);
      if (!isCurrentRun(token, pageUrl)) return;
      const pending = applyItems(blocks, cachedItems);
      let firstBatch = true;
      let failure = null;
      const worker = async () => {
        while (pending.length && !failure && token === state.runToken) {
          await waitForVisiblePage(token, pageUrl);
          if (!isCurrentRun(token, pageUrl) || failure || !pending.length) return;
          // Re-evaluate when a slot opens: scrolling changes what matters next.
          // Read layout once per block, not repeatedly inside the sort.
          const distances = new Map(pending.map((block) => [block, viewportDistance(block)]));
          pending.sort((left, right) => distances.get(left) - distances.get(right));
          const visibleCount = pending.filter((block) => distances.get(block) === 0).length;
          const smallBatch = firstBatch || visibleCount > 0;
          // Visible text must not wait for unrelated offscreen paragraphs in
          // the same model response. Keep all visible batches small, including
          // those scheduled after scrolling; larger background batches retain
          // throughput without increasing the concurrency limit.
          const batch = takeNextBatch(pending,
            visibleCount ? Math.min(FIRST_BATCH_SIZE, visibleCount) : smallBatch ? FIRST_BATCH_SIZE : BATCH_SIZE,
            smallBatch ? VISIBLE_BATCH_CHAR_LIMIT : App.BATCH_CHAR_LIMIT);
          firstBatch = false;
          try {
            const items = await translateBatch(batch, false, pageUrl, (items) => applyItems(batch, items));
            if (!isCurrentRun(token, pageUrl)) return;
            const missing = applyItems(batch, items);
            if (missing.length) throw new Error("Translation missing for some blocks. Click to retry.");
          } catch (error) {
            if (!isCurrentRun(token, pageUrl)) return;
            // Stop scheduling after an error, but let already-sent requests
            // finish and render so a late success cannot overwrite error state.
            if (!failure || isUncertainRequest(error)) failure = error;
            for (const block of batch) {
              if (block.container.dataset.ytbtState !== "done") {
                App.renderTranslationError(block, isUncertainRequest(error) ? "等待恢复译文" : "此段翻译未完成，点击翻译按钮重试。");
                if (isUncertainRequest(error)) block.container.dataset.ytbtState = "waiting";
              }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: MAX_CONCURRENT_BATCHES }, () => worker()));
      if (!isCurrentRun(token, pageUrl)) return;
      if (failure) throw failure;

      state.translated = true;
      App.updateBallMode("done");
      App.showStatus(`Done. Added ${translatedCount} bilingual translations.`);
    } catch (error) {
      if (!isCurrentRun(token, pageUrl)) return;
      App.updateBallMode("error");
      const message = error && error.message ? error.message : String(error);
      for (const block of blocks) {
        if (block.container && block.container.dataset.ytbtState === "loading") {
          block.container.dataset.ytbtState = "paused";
          block.container.removeAttribute("aria-busy");
          block.container.hidden = true;
        }
      }
      if (isUncertainRequest(error)) {
        state.recovery = { token, pageUrl, blocks, polls: 0 };
        App.showStatus("翻译响应暂时中断，已完成的译文会保留。正在检查缓存，不会自动重发付费请求。", true);
        await recoverCachedTranslations();
      } else {
        App.showStatus(`翻译暂停：${message}`, true);
      }
    }
  }

  function viewportDistance(block) {
    const rect = block.element.getBoundingClientRect();
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > window.innerHeight) return rect.top - window.innerHeight;
    return 0;
  }

  function takeNextBatch(pending, maxSize, charLimit) {
    const batch = [];
    let currentChars = 0;
    while (pending.length && batch.length < maxSize) {
      const block = pending[0];
      const textLength = (block.formattedText || block.sourceText).length;
      // A single long paragraph stays intact to preserve context/formatting.
      if (batch.length && currentChars + textLength > charLimit) break;
      batch.push(pending.shift());
      currentChars += textLength;
    }
    return batch;
  }

  async function translateBatch(batch, cacheOnly = false, pageUrl = state.pageUrl, onProgress) {
    if (!batch.length) return [];
    const message = {
      type: "IMMERSIVE_TRANSLATE",
      pageUrl,
      cacheOnly,
      preferences: {
        immersiveSourceLanguage: state.runPreferences?.immersiveSourceLanguage || "auto",
        immersiveTargetLanguage: state.runPreferences?.immersiveTargetLanguage || state.runPreferences?.targetLanguage || "zh-CN",
        immersiveTranslationService: state.runPreferences?.immersiveTranslationService || "ai"
      },
      items: batch.map((block) => ({
        id: block.id,
        sourceText: block.sourceText,
        formattedText: block.formattedText
      }))
    };
    const response = cacheOnly ? await sendMessage(message) : await sendWithCacheProgress(message, onProgress);

    if (!response || response.ok === false) {
      const error = response && response.errors && response.errors[0];
      throw new Error(error && error.message ? error.message : "Translation request failed.");
    }

    return Array.isArray(response.items) ? response.items : [];
  }

  function sendWithCacheProgress(message, onProgress) {
    const token = state.runToken;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(response);
      }
      const current = () => !settled && isCurrentRun(token, message.pageUrl);
      const poll = async () => {
        if (!current()) return;
        try {
          // Short read-only messages retrieve persisted results even if the
          // original response channel is stuck, and give a busy MV3 worker
          // activity while it waits on a slow provider. Never replay paid work.
          const response = await sendMessage({ ...message, cacheOnly: true });
          if (!current()) return;
          if (!response || response.ok === false || !Array.isArray(response.items)) return;
          const items = response.items.filter((item) => item && item.translatedText);
          // Fallback providers can persist individual paragraphs while other
          // paragraphs are still running. Show that progress on every probe.
          if (items.length && onProgress) onProgress(items);
          const completed = new Set(items.map((item) => String(item.id)));
          if (message.items.every((item) => completed.has(String(item.id)))) {
            finish(null, response);
          }
        } catch (_) {
          // A failed cache probe does not cancel the original request.
        } finally {
          if (current()) timer = setTimeout(poll, CACHE_POLL_INTERVAL_MS);
        }
      };
      timer = setTimeout(poll, CACHE_POLL_INTERVAL_MS);
      sendMessage(message).then((response) => finish(null, response), (error) => finish(error));
    });
  }

  function sendMessage(message) {
    return Core.sendRuntimeMessage(chrome.runtime, message, message.cacheOnly ? CACHE_MESSAGE_TIMEOUT_MS : MESSAGE_TIMEOUT_MS);
  }

  Object.assign(App, { syncPageIdentity, recoverCachedTranslations, translateCurrentPage });
})();
