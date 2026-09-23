(function runImmersiveTranslator() {
  "use strict";

  const Core = globalThis.YTBTCore;
  if (!Core || !globalThis.chrome || !chrome.runtime || window.top !== window) {
    return;
  }

  const BLOCK_SELECTOR = [
    ".entry-content h1",
    ".entry-content h2",
    ".entry-content h3",
    ".entry-content h4",
    ".entry-content h5",
    ".entry-content h6",
    ".entry-content p",
    ".entry-content li",
    ".entry-content blockquote",
    ".entry-content figcaption",
    ".entry-content dd",
    ".post-content h1",
    ".post-content h2",
    ".post-content h3",
    ".post-content h4",
    ".post-content h5",
    ".post-content h6",
    ".post-content p",
    ".post-content li",
    ".post-content blockquote",
    ".post-content figcaption",
    ".post-content dd",
    ".article-content h1",
    ".article-content h2",
    ".article-content h3",
    ".article-content h4",
    ".article-content h5",
    ".article-content h6",
    ".article-content p",
    ".article-content li",
    ".article-content blockquote",
    ".article-content figcaption",
    ".article-content dd",
    "#content h1",
    "#content h2",
    "#content h3",
    "#content h4",
    "#content h5",
    "#content h6",
    "#content p",
    "#content li",
    "#content blockquote",
    "article h1",
    "article h2",
    "article h3",
    "article h4",
    "article h5",
    "article h6",
    "article p",
    "article li",
    "article blockquote",
    "article figcaption",
    "article dd",
    "article header a",
    "article header span",
    "article header time",
    "main h1",
    "main h2",
    "main h3",
    "main h4",
    "main h5",
    "main h6",
    "main p",
    "main li",
    "main blockquote",
    "main figcaption",
    "main dd",
    "main header a",
    "main header span",
    "main header time",
    "[role='main'] h1",
    "[role='main'] h2",
    "[role='main'] h3",
    "[role='main'] h4",
    "[role='main'] h5",
    "[role='main'] h6",
    "[role='main'] p",
    "[role='main'] li",
    "[role='main'] blockquote",
    "[role='main'] figcaption",
    "[role='main'] dd",
    "[role='main'] header a",
    "[role='main'] header span",
    "[role='main'] header time",
    "body > h1",
    "body > h2",
    "body > h3",
    "body > h4",
    "body > h5",
    "body > h6",
    "body > p",
    "body > ul > li",
    "body > ol > li",
    "figcaption",
    "dd"
  ].join(",");
  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "pre",
    "code",
    "button",
    "input",
    "textarea",
    "select",
    "footer",
    "form",
    "[role='menu']",
    "[role='menubar']",
    "[role='button']",
    "[role='tab']",
    "[role='tablist']",
    "[contenteditable='true']",
    "[translate='no']",
    "[aria-hidden='true']",
    "[data-ytbt-immersive-root]",
    "[data-ytbt-immersive-translation]"
  ].join(",");
  // Documentation callouts and page outlines are readable content, even when
  // their sites use the same semantic tags as global navigation/sidebar chrome.
  const TOC_SELECTOR = "#toc, #toc-side, .toc, .table-of-contents, [role='doc-toc'], [aria-label='Table of contents' i]";
  const CALLOUT_SELECTOR = "aside.alert, aside.admonition, aside.callout, aside[role='note']";
  const CALLOUT_TITLE_SELECTOR = ".alert-header, .admonition-title, .callout-title";
  const CONTENT_SCOPE_SELECTOR = [
    "article",
    "main",
    "[role='main']",
    ".entry-content",
    ".post-content",
    ".article-content",
    ".article-body",
    ".post-body",
    ".markdown-body",
    ".prose",
    ".content",
    ".container",
    ".post",
    ".article",
    "#content"
  ].join(",");
  const READABLE_LEAF_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "figcaption",
    "caption",
    "dt",
    "dd",
    "td",
    "th",
    "summary",
    "time",
    "small",
    "a",
    "span",
    "strong",
    "em",
    "b",
    "i"
  ].join(",");
  const READABLE_DESCENDANT_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "figcaption",
    "caption",
    "dt",
    "dd",
    "td",
    "th",
    "summary",
    "div",
    "section",
    "article",
    "table",
    "ul",
    "ol"
  ].join(",");
  const SHORT_TEXT_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dt",
    "figcaption",
    "caption",
    "article header a",
    "article header span",
    "article header time",
    "main header a",
    "main header span",
    "main header time",
    "[role='main'] header a",
    "[role='main'] header span",
    "[role='main'] header time"
  ].join(",");
  const SHORT_TEXT_CLASS_SELECTOR = [
    "[class*='title' i]",
    "[class*='heading' i]",
    "[class*='headline' i]",
    "[class*='byline' i]",
    "[class*='author' i]",
    "[class*='meta' i]"
  ].join(",");
  const CONTAINER_TEXT_TAGS = new Set(["DIV", "SECTION", "HEADER", "ARTICLE", "MAIN"]);
  const MAX_BLOCKS = 240;
  const MIN_TEXT_LENGTH = 24;
  const MAX_TEXT_LENGTH = 4000;
  const BATCH_SIZE = 8;
  const FIRST_BATCH_SIZE = 4;
  const MAX_CONCURRENT_BATCHES = 3;
  const BATCH_CHAR_LIMIT = 7000;
  // Three 60s provider attempts plus up to 45s of retry backoff and persistence.
  const MESSAGE_TIMEOUT_MS = 240000;
  const CACHE_MESSAGE_TIMEOUT_MS = 15000;
  const DEFAULT_BALL_TOP_PCT = 50;
  const BALL_EDGE_PADDING_PX = 8;
  const BALL_DRAG_THRESHOLD_PX = 4;

  const state = {
    ball: null,
    ballText: null,
    panel: null,
    panelTimer: null,
    mode: "idle",
    visible: true,
    translated: false,
    runToken: 0,
    pageUrl: pageIdentity(),
    recovery: null,
    recovering: false,
    ballTopPct: DEFAULT_BALL_TOP_PCT,
    ballDrag: {
      pointerId: null,
      startClientY: 0,
      lastClientY: 0,
      offsetY: 0,
      active: false,
      suppressClick: false
    }
  };

  init();

  function init() {
    const root = document.documentElement;
    if (!root || root.dataset.ytbtImmersiveReady === "true") {
      return;
    }
    root.dataset.ytbtImmersiveReady = "true";
    document.addEventListener("visibilitychange", () => {
      syncPageIdentity();
      if (!document.hidden) recoverCachedTranslations();
    });
    window.addEventListener("pageshow", () => {
      syncPageIdentity();
      recoverCachedTranslations();
    });
    window.addEventListener("popstate", syncPageIdentity);
    // SPA navigation need not dispatch popstate. Never attribute old text to
    // a new URL or let an old response change the new page's controls.
    setInterval(syncPageIdentity, 1000);

    if (document.body) {
      mountControls();
    } else {
      document.addEventListener("DOMContentLoaded", mountControls, { once: true });
    }
  }

  function mountControls() {
    if (state.ball || !document.body) {
      return;
    }

    const ballContainer = document.createElement("div");
    ballContainer.className = "ytbt-immersive-tab";
    ballContainer.dataset.ytbtImmersiveRoot = "true";

    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "ytbt-immersive-ball";
    ball.setAttribute("aria-label", "Immersive translate");
    ball.title = "Immersive translate";

    ball.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
    </svg>`;
    
    ballContainer.appendChild(ball);

    const panel = document.createElement("div");
    panel.className = "ytbt-immersive-panel";
    panel.dataset.ytbtImmersiveRoot = "true";
    panel.hidden = true;
    panel.setAttribute("role", "status");

    ballContainer.addEventListener("pointerdown", handleBallPointerDown, true);
    ballContainer.addEventListener("click", handleBallClick);
    document.body.appendChild(ballContainer);
    document.body.appendChild(panel);

    state.ball = ballContainer;
    state.ballText = null;
    state.panel = panel;
    loadBallPosition();
    updateBallMode("idle");
  }

  async function handleBallClick(event) {
    event.preventDefault();
    event.stopPropagation();
    syncPageIdentity();

    if (state.ballDrag.suppressClick) {
      state.ballDrag.suppressClick = false;
      return;
    }

    if (state.mode === "translating") {
      showStatus("Translation is already running...", true);
      return;
    }

    if (state.translated) {
      state.visible = !state.visible;
      document.documentElement.classList.toggle("ytbt-immersive-hidden", !state.visible);
      showStatus(state.visible ? "Bilingual translations shown." : "Bilingual translations hidden.");
      updateBallMode(state.visible ? "done" : "idle");
      return;
    }

    await translateCurrentPage();
  }

  function handleBallPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (state.ballDrag.pointerId != null) {
      cancelBallDrag();
    }

    const rect = state.ball.getBoundingClientRect();
    state.ballDrag.pointerId = event.pointerId;
    state.ballDrag.startClientX = event.clientX;
    state.ballDrag.startClientY = event.clientY;
    state.ballDrag.offsetY = event.clientY - rect.top;
    state.ballDrag.startRight = parseFloat(window.getComputedStyle(state.ball).right) || 0;
    state.ballDrag.active = false;

    state.ball.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", handleBallPointerMove, true);
    document.addEventListener("pointerup", handleBallPointerUp, true);
    document.addEventListener("pointercancel", handleBallPointerCancel, true);
  }

  function handleBallPointerMove(event) {
    const drag = state.ballDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    const distanceX = Math.abs(event.clientX - drag.startClientX);
    const distanceY = Math.abs(event.clientY - drag.startClientY);
    if (!drag.active && (distanceX >= BALL_DRAG_THRESHOLD_PX || distanceY >= BALL_DRAG_THRESHOLD_PX)) {
      drag.active = true;
      state.ball.classList.add("ytbt-immersive-dragging");
    }

    if (!drag.active) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    moveBallToClient(event.clientX, event.clientY);
  }

  function handleBallPointerUp(event) {
    const drag = state.ballDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    if (drag.active) {
      event.preventDefault();
      event.stopPropagation();
      drag.suppressClick = true;
      state.ball.style.right = "0px";
      saveBallPosition();
    }
    cancelBallDrag();
  }

  function handleBallPointerCancel(event) {
    if (event && state.ballDrag.pointerId !== event.pointerId) {
      return;
    }
    if (state.ballDrag.active && state.ball) {
      state.ball.style.right = "0px";
    }
    cancelBallDrag();
  }

  function cancelBallDrag() {
    if (state.ball && state.ballDrag.pointerId != null) {
      try {
        state.ball.releasePointerCapture(state.ballDrag.pointerId);
      } catch (error) {
        // Ignore browsers that already released the pointer.
      }
      state.ball.classList.remove("ytbt-immersive-dragging");
    }

    document.removeEventListener("pointermove", handleBallPointerMove, true);
    document.removeEventListener("pointerup", handleBallPointerUp, true);
    document.removeEventListener("pointercancel", handleBallPointerCancel, true);

    state.ballDrag.pointerId = null;
    state.ballDrag.active = false;
  }

  function moveBallToClient(clientX, clientY) {
    if (!state.ball) {
      return;
    }

    const rect = state.ball.getBoundingClientRect();
    const halfHeight = rect.height / 2 || 16;
    const minCenterY = BALL_EDGE_PADDING_PX + halfHeight;
    const maxCenterY = window.innerHeight - BALL_EDGE_PADDING_PX - halfHeight;
    const rawCenterY = clientY - state.ballDrag.offsetY + halfHeight;
    const centerY = clamp(rawCenterY, Math.min(minCenterY, maxCenterY), Math.max(minCenterY, maxCenterY));

    state.ballTopPct = (centerY / Math.max(1, window.innerHeight)) * 100;
    
    let newRight = state.ballDrag.startRight - (clientX - state.ballDrag.startClientX);
    newRight = clamp(newRight, 0, window.innerWidth - rect.width);
    state.ball.style.right = `${newRight}px`;
    
    applyBallPosition();
  }

  function applyBallPosition() {
    const topPct = clamp(Number(state.ballTopPct) || DEFAULT_BALL_TOP_PCT, 4, 96);
    state.ballTopPct = topPct;

    if (state.ball) {
      state.ball.style.top = `${topPct}%`;
    }
    if (state.panel) {
      state.panel.style.top = `min(calc(${topPct}% + 24px), calc(100vh - 64px))`;
    }
  }

  async function loadBallPosition() {
    try {
      const values = await storageGet({ immersiveBallTopPct: DEFAULT_BALL_TOP_PCT });
      state.ballTopPct = normalizeBallTopPct(values.immersiveBallTopPct);
      applyBallPosition();
    } catch (error) {
      applyBallPosition();
    }
  }

  async function saveBallPosition() {
    const topPct = normalizeBallTopPct(state.ballTopPct);
    state.ballTopPct = topPct;
    applyBallPosition();
    try {
      await storageSet({ immersiveBallTopPct: topPct });
    } catch (error) {
      // Position persistence is nice-to-have; dragging should still work.
    }
  }

  function normalizeBallTopPct(value) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, 4, 96) : DEFAULT_BALL_TOP_PCT;
  }

  function pageIdentity() {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
  }

  function syncPageIdentity() {
    const url = pageIdentity();
    if (state.pageUrl === url) return;
    state.pageUrl = url;
    state.runToken += 1;
    state.recovery = null;
    state.translated = false;
    clearExistingTranslations();
    updateBallMode("idle");
    if (state.panel) state.panel.hidden = true;
    window.dispatchEvent(new Event("ytbt-page-changed"));
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

  async function recoverCachedTranslations() {
    const recovery = state.recovery;
    if (!recovery || state.recovering || document.hidden || !isCurrentRun(recovery.token, recovery.pageUrl)) return;
    state.recovering = true;
    try {
      const pending = recovery.blocks.filter((block) => block.element.isConnected && block.container.dataset.ytbtState !== "done");
      const items = await translateBatch(pending, true, recovery.pageUrl);
      if (!isCurrentRun(recovery.token, recovery.pageUrl) || recovery !== state.recovery) return;
      const byId = new Map(items.map((item) => [String(item.id), item.translatedText]));
      for (const block of pending) {
        if (byId.get(block.id)) renderTranslation(block, byId.get(block.id));
      }
      const remaining = recovery.blocks.filter((block) => block.element.isConnected && block.container.dataset.ytbtState !== "done").length;
      if (!remaining) {
        state.recovery = null;
        state.translated = true;
        updateBallMode("done");
        showStatus("已从缓存恢复全部译文，没有重新请求翻译。");
      } else {
        showStatus(`已保留完成的译文，还有 ${remaining} 段未完成。切回页面时会再次检查缓存；点击翻译按钮可手动继续。`, true);
      }
    } catch (_) {
      // A failed read must never become a paid retry. Keep recovery available
      // for the next pageshow/visibility event or an explicit user click.
      if (isCurrentRun(recovery.token, recovery.pageUrl) && recovery === state.recovery) {
        showStatus("暂时无法读取译文缓存。请稍后切回页面，或刷新后点击翻译按钮。", true);
      }
    } finally {
      state.recovering = false;
    }
  }

  async function translateCurrentPage() {
    syncPageIdentity();
    const pageUrl = state.pageUrl;
    state.recovery = null;
    clearExistingTranslations();
    const blocks = collectBlocks();
    if (!blocks.length) {
      updateBallMode("idle");
      showStatus("No readable English text found on this page.");
      return;
    }

    const token = (state.runToken += 1);
    state.translated = false;
    state.visible = true;
    document.documentElement.classList.remove("ytbt-immersive-hidden");
    updateBallMode("translating");
    showStatus(`Translating 0/${blocks.length} blocks...`, true);

    for (const block of blocks) {
      block.container = createTranslationContainer(block);
    }

    let translatedCount = 0;
    try {
      const applyItems = (batch, items) => {
        const translatedById = new Map(items.filter((item) => item && item.translatedText)
          .map((item) => [String(item.id), Core.normalizeSubtitleText(item.translatedText)]));
        const missing = [];
        for (const block of batch) {
          const translatedText = translatedById.get(block.id);
          if (translatedText) {
            renderTranslation(block, translatedText);
            translatedCount += 1;
          } else {
            missing.push(block);
          }
        }
        showStatus(`Translating ${translatedCount}/${blocks.length} blocks...`, true);
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
          pending.sort((left, right) => viewportDistance(left) - viewportDistance(right));
          const batch = takeNextBatch(pending, firstBatch ? FIRST_BATCH_SIZE : BATCH_SIZE);
          firstBatch = false;
          try {
            const items = await translateBatch(batch, false, pageUrl);
            if (!isCurrentRun(token, pageUrl)) return;
            const missing = applyItems(batch, items);
            if (missing.length) throw new Error("Translation missing for some blocks. Click to retry.");
          } catch (error) {
            if (!isCurrentRun(token, pageUrl)) return;
            // Stop scheduling after an error, but let already-sent requests
            // finish and render so a late success cannot overwrite error state.
            failure = failure || error;
            for (const block of batch) {
              if (block.container.dataset.ytbtState !== "done") {
                renderTranslationError(block, isUncertainRequest(error) ? "等待恢复译文" : "此段翻译未完成，点击翻译按钮重试。");
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
      updateBallMode("done");
      showStatus(`Done. Added ${translatedCount} bilingual translations.`);
    } catch (error) {
      if (!isCurrentRun(token, pageUrl)) return;
      updateBallMode("error");
      const message = error && error.message ? error.message : String(error);
      for (const block of blocks) {
        if (block.container && block.container.dataset.ytbtState === "loading") {
          block.container.dataset.ytbtState = "paused";
          block.container.hidden = true;
        }
      }
      if (isUncertainRequest(error)) {
        state.recovery = { token, pageUrl, blocks };
        showStatus("翻译响应暂时中断，已完成的译文会保留。正在检查缓存，不会自动重发付费请求。", true);
        await recoverCachedTranslations();
      } else {
        showStatus(`翻译暂停：${message}`, true);
      }
    }
  }

  function collectBlocks() {
    const candidates = collectCandidateElements();
    const blocks = [];

    for (const element of candidates) {
      if (blocks.length >= MAX_BLOCKS) {
        break;
      }
      if (!isUsableBlock(element)) {
        continue;
      }

      const text = extractReadableText(element);
      if (!looksLikeEnglishTextForElement(element, text)) {
        continue;
      }

      const id = `im${blocks.length}`;
      element.dataset.ytbtImmersiveSource = id;
      element.classList.add("ytbt-immersive-source");
      blocks.push({ id, element, sourceText: text, ...extractInlineFormatting(element) });
    }

    return blocks;
  }

  function collectCandidateElements() {
    const seen = new Set();
    for (const element of document.querySelectorAll(BLOCK_SELECTOR)) {
      seen.add(element);
    }

    for (const root of collectContentRoots()) {
      collectHeuristicCandidates(root, seen);
    }
    // Page outlines commonly sit outside main/article.
    for (const root of document.querySelectorAll(TOC_SELECTOR)) {
      collectHeuristicCandidates(root, seen);
    }

    return Array.from(seen).sort(compareDocumentOrder);
  }

  function collectContentRoots() {
    const roots = [];
    for (const root of document.querySelectorAll(CONTENT_SCOPE_SELECTOR)) {
      if (!root || roots.some((existing) => existing.contains(root))) {
        continue;
      }
      if (!isVisible(root)) {
        continue;
      }
      const text = Core.normalizeSubtitleText(root.innerText || root.textContent || "");
      if (text.length >= MIN_TEXT_LENGTH) {
        roots.push(root);
      }
    }

    return roots.length ? roots : [document.body].filter(Boolean);
  }

  function collectHeuristicCandidates(root, seen) {
    if (!root) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    while (element) {
      if (isHeuristicCandidate(element)) {
        seen.add(element);
      }
      element = walker.nextNode();
    }
  }

  function isHeuristicCandidate(element) {
    if (!element || element === document.body || element === document.documentElement) {
      return false;
    }
    if (isExcludedFromTranslation(element)) {
      return false;
    }
    if (isInSiteChromeHeader(element)) {
      return false;
    }
    if (element.closest(".ytp-caption-window-container, .caption-window, .ytbt-overlay")) {
      return false;
    }
    if (!isVisible(element)) {
      return false;
    }

    if (element.matches(READABLE_LEAF_SELECTOR)) {
      return true;
    }

    if (!CONTAINER_TEXT_TAGS.has(element.tagName)) {
      return false;
    }
    if (hasReadableDescendantBlock(element)) {
      return false;
    }

    const text = extractReadableText(element);
    return looksLikeEnglishTextForElement(element, text);
  }

  function compareDocumentOrder(left, right) {
    if (left === right) {
      return 0;
    }
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  }

  function isUsableBlock(element) {
    if (!element || isExcludedFromTranslation(element)) {
      return false;
    }
    if (element.closest("[data-ytbt-immersive-source]")) {
      return false;
    }
    if (isInSiteChromeHeader(element)) {
      return false;
    }
    // Keep outline translations inside their links, including short entries.
    if (element.closest(TOC_SELECTOR) && element.querySelector("a[href]")) {
      return false;
    }
    // Put the translation inside the title's text wrapper, not beside the
    // icon as another flex item (as used by Flutter's alert headers).
    if (element.matches(CALLOUT_TITLE_SELECTOR) &&
        element.querySelector("span:not([aria-hidden='true']):not([translate='no'])")) {
      return false;
    }
    if (!isShortTextBlock(element) && (element.querySelector(BLOCK_SELECTOR) || hasReadableDescendantBlock(element))) {
      return false;
    }
    if (element.closest(".ytp-caption-window-container, .caption-window, .ytbt-overlay")) {
      return false;
    }
    if (!isVisible(element)) {
      return false;
    }
    return true;
  }

  function isInSiteChromeHeader(element) {
    const header = element.closest("header");
    return Boolean(header && !header.closest(CONTENT_SCOPE_SELECTOR) && !header.closest(TOC_SELECTOR));
  }

  function isExcludedFromTranslation(element) {
    if (element.closest(SKIP_SELECTOR)) {
      return true;
    }
    const toc = element.closest(TOC_SELECTOR);
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (!ancestor.matches("nav, aside, [role='navigation']")) {
        continue;
      }
      if (toc && (ancestor.contains(toc) || toc.contains(ancestor))) {
        continue;
      }
      if (ancestor.matches(CALLOUT_SELECTOR) && ancestor.closest(CONTENT_SCOPE_SELECTOR)) {
        continue;
      }
      return true;
    }
    return false;
  }

  function hasReadableDescendantBlock(element) {
    for (const descendant of element.querySelectorAll(READABLE_DESCENDANT_SELECTOR)) {
      if (descendant === element || isExcludedFromTranslation(descendant)) {
        continue;
      }
      if (!isVisible(descendant)) {
        continue;
      }
      const text = extractReadableText(descendant);
      if (looksLikeEnglishTextForElement(descendant, text)) {
        return true;
      }
    }
    return false;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function extractReadableText(element) {
    const clone = element.cloneNode(true);
    for (const injected of clone.querySelectorAll("[data-ytbt-immersive-translation], [aria-hidden='true']")) {
      injected.remove();
    }

    const text = Core.normalizeSubtitleText(clone.textContent || "");
    if (text.length > MAX_TEXT_LENGTH) {
      return "";
    }
    return text;
  }

  function looksLikeEnglishText(text) {
    return looksLikeEnglishTextForElement(null, text);
  }

  function extractInlineFormatting(element) {
    const formats = new Map();
    const tags = new Set(["CODE", "KBD", "SAMP", "STRONG", "B", "EM", "I", "A", "S", "DEL", "U", "MARK", "SUB", "SUP", "BR"]);
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches("[data-ytbt-immersive-translation], [aria-hidden='true'], script, style")) return "";
      if (!tags.has(node.tagName)) return Array.from(node.childNodes, visit).join("");
      const key = `${node.tagName}_${formats.size}`;
      const template = document.createElement(node.tagName.toLowerCase());
      // Copy appearance, never IDs, handlers or arbitrary source attributes.
      template.className = node.className;
      const style = window.getComputedStyle(node);
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "color", "background-color", "border", "border-radius", "padding", "text-decoration", "vertical-align", "white-space"]) {
        const value = style.getPropertyValue(property);
        if (value) template.style.setProperty(property, value);
      }
      if (node.tagName === "A") {
        const href = node.getAttribute("href");
        try {
          if (href && /^(https?:|mailto:|tel:)$/i.test(new URL(href, document.baseURI).protocol)) template.setAttribute("href", href);
        } catch (_) { /* Malformed links remain readable text. */ }
      }
      const literal = /^(CODE|KBD|SAMP)$/.test(node.tagName);
      formats.set(key, { template, literal, sourceText: node.textContent });
      const content = literal ? node.textContent : Array.from(node.childNodes, visit).join("");
      return `[[YTBT_${key}]]${content}[[/YTBT_${key}]]`;
    }
    const formattedText = Array.from(element.childNodes, visit).join("").replace(/\s+/g, " ").trim();
    // Do not interpret marker-like source text as our own formatting protocol.
    if (/\[\[\/?YTBT_/.test(element.textContent)) return { formats: new Map() };
    return { formats, formattedText: formats.size && formattedText.length <= BATCH_CHAR_LIMIT ? formattedText : undefined };
  }

  function renderInlineTranslation(block, translatedText) {
    const fragment = document.createDocumentFragment();
    const formats = block.formats;
    if (!formats.size) {
      fragment.appendChild(document.createTextNode(translatedText));
      return fragment;
    }
    const marker = /\[\[(\/?)YTBT_([A-Z]+_\d+)\]\]/g;
    const stack = [{ node: fragment, key: null }];
    const used = new Set();
    let cursor = 0;
    let valid = true;
    for (const match of translatedText.matchAll(marker)) {
      stack[stack.length - 1].node.appendChild(document.createTextNode(translatedText.slice(cursor, match.index)));
      cursor = match.index + match[0].length;
      const [, closing, key] = match;
      const format = formats.get(key);
      if (!format || (closing ? stack[stack.length - 1].key !== key : used.has(key))) {
        valid = false;
        break;
      }
      if (closing) {
        const entry = stack.pop();
        if (format.literal) entry.node.textContent = format.sourceText;
      } else {
        const node = format.template.cloneNode(false);
        stack[stack.length - 1].node.appendChild(node);
        stack.push({ node, key });
        used.add(key);
      }
    }
    if (valid && stack.length === 1 && used.size === formats.size) {
      fragment.appendChild(document.createTextNode(translatedText.slice(cursor)));
      return fragment;
    }
    // Old cached translations and providers that drop markers still retain
    // literal code styling locally, without another billable translation.
    const plain = translatedText.replace(marker, "");
    const literals = Array.from(formats.values()).filter((format) => format.literal && format.sourceText)
      .sort((a, b) => b.sourceText.length - a.sourceText.length);
    const fallback = document.createDocumentFragment();
    let start = 0;
    for (let index = 0; index < plain.length; index += 1) {
      const format = literals.find(({ sourceText }) => plain.startsWith(sourceText, index) &&
        !(/[\w$]/.test(sourceText[0]) && /[\w$]/.test(plain[index - 1] || "")) &&
        !(/[\w$]/.test(sourceText.at(-1)) && /[\w$]/.test(plain[index + sourceText.length] || "")));
      if (!format) continue;
      let end = index + format.sourceText.length;
      let before = index;
      // Some providers add Markdown backticks even to old plain-text input.
      while (before > start && plain[before - 1] === "`" && plain[end] === "`") { before -= 1; end += 1; }
      fallback.appendChild(document.createTextNode(plain.slice(start, before)));
      const node = format.template.cloneNode(false);
      node.textContent = format.sourceText;
      fallback.appendChild(node);
      start = end;
      index = end - 1;
    }
    fallback.appendChild(document.createTextNode(plain.slice(start)));
    return fallback;
  }

  function looksLikeEnglishTextForElement(element, text) {
    if (!text) {
      return false;
    }
    if (!/[A-Za-z]/.test(text)) {
      return false;
    }
    if (/^https?:\/\//i.test(text) || /^[\d\s.,:;!?()[\]{}'"`~@#$%^&*_+=|\\/-]+$/.test(text)) {
      return false;
    }

    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    if (isShortTextBlock(element)) {
      return words.length >= 1 && text.length >= 2;
    }

    return text.length >= MIN_TEXT_LENGTH && words.length >= 4;
  }

  function isShortTextBlock(element) {
    return Boolean(
      element &&
        (element.matches(SHORT_TEXT_SELECTOR) ||
          (element.closest(TOC_SELECTOR) && element.matches("a[href], header, header span")) ||
          (element.closest(CALLOUT_SELECTOR) && element.closest(CALLOUT_TITLE_SELECTOR)) ||
          (element.closest(CONTENT_SCOPE_SELECTOR) && element.matches(SHORT_TEXT_CLASS_SELECTOR)))
    );
  }

  function clearExistingTranslations() {
    for (const node of document.querySelectorAll("[data-ytbt-immersive-translation]")) {
      node.remove();
    }
    for (const source of document.querySelectorAll("[data-ytbt-immersive-source]")) {
      delete source.dataset.ytbtImmersiveSource;
      source.classList.remove("ytbt-immersive-source");
    }
  }

  function createTranslationContainer(block) {
    const previous = document.querySelector(`[data-ytbt-immersive-for="${block.id}"]`);
    if (previous) {
      previous.remove();
    }

    const container = document.createElement("span");
    container.className = "ytbt-immersive-translation";
    if ((block.element.closest(TOC_SELECTOR) && block.element.matches("a[href]")) ||
        (block.element.closest(CALLOUT_SELECTOR) && block.element.closest(CALLOUT_TITLE_SELECTOR))) {
      container.classList.add("ytbt-immersive-stacked");
    }
    container.dataset.ytbtImmersiveTranslation = "true";
    container.dataset.ytbtImmersiveFor = block.id;
    container.dataset.ytbtState = "loading";

    const text = document.createElement("span");
    text.className = "ytbt-immersive-text";
    text.textContent = "Translating...";

    container.appendChild(text);
    block.element.appendChild(container);

    return container;
  }

  function renderTranslation(block, translatedText) {
    const container = block.container;
    if (!container || !block.element.isConnected) {
      return;
    }
    container.hidden = false;
    const text = container.querySelector(".ytbt-immersive-text");
    if (text) {
      text.replaceChildren(renderInlineTranslation(block, translatedText));
    }
    container.dataset.ytbtState = "done";
  }

  function renderTranslationError(block, message) {
    const container = block.container;
    if (!container) {
      return;
    }
    const text = container.querySelector(".ytbt-immersive-text");
    if (text) {
      text.textContent = message || "Translation failed.";
    }
    container.dataset.ytbtState = "error";
  }

  function viewportDistance(block) {
    const rect = block.element.getBoundingClientRect();
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > window.innerHeight) return rect.top - window.innerHeight;
    return 0;
  }

  function takeNextBatch(pending, maxSize) {
    const batch = [];
    let currentChars = 0;
    while (pending.length && batch.length < maxSize) {
      const block = pending[0];
      const textLength = (block.formattedText || block.sourceText).length;
      if (batch.length && currentChars + textLength > BATCH_CHAR_LIMIT) break;
      batch.push(pending.shift());
      currentChars += textLength;
    }
    return batch;
  }

  async function translateBatch(batch, cacheOnly = false, pageUrl = state.pageUrl) {
    const response = await sendMessage({
      type: "IMMERSIVE_TRANSLATE",
      pageUrl,
      cacheOnly,
      items: batch.map((block) => ({
        id: block.id,
        sourceText: block.sourceText,
        formattedText: block.formattedText
      }))
    });

    if (!response || response.ok === false) {
      const error = response && response.errors && response.errors[0];
      throw new Error(error && error.message ? error.message : "Translation request failed.");
    }

    return Array.isArray(response.items) ? response.items : [];
  }

  function sendMessage(message) {
    return Core.sendRuntimeMessage(chrome.runtime, message, message.cacheOnly ? CACHE_MESSAGE_TIMEOUT_MS : MESSAGE_TIMEOUT_MS);
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function updateBallMode(mode) {
    state.mode = mode;
    if (!state.ball) {
      return;
    }
    state.ball.dataset.ytbtState = mode;
  }

  function showStatus(message, persistent) {
    if (!state.panel) {
      return;
    }

    state.panel.textContent = message;
    state.panel.hidden = false;

    if (state.panelTimer) {
      clearTimeout(state.panelTimer);
      state.panelTimer = null;
    }

    if (!persistent) {
      state.panelTimer = setTimeout(() => {
        if (state.panel) {
          state.panel.hidden = true;
        }
      }, 3600);
    }
  }
})();
