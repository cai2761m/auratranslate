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
    "nav",
    "aside",
    "footer",
    "form",
    "[role='navigation']",
    "[role='menu']",
    "[role='menubar']",
    "[role='button']",
    "[role='tab']",
    "[role='tablist']",
    "[contenteditable='true']",
    "[aria-hidden='true']",
    "[data-ytbt-immersive-root]",
    "[data-ytbt-immersive-translation]"
  ].join(",");
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
  const BATCH_CHAR_LIMIT = 7000;
  const MESSAGE_TIMEOUT_MS = 180000;
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

  async function translateCurrentPage() {
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
      const batches = makeBatches(blocks);
      for (const batch of batches) {
        if (token !== state.runToken) {
          return;
        }

        const items = await translateBatch(batch);
        const translatedById = new Map();
        for (const item of items) {
          if (item && item.id != null && item.translatedText) {
            translatedById.set(String(item.id), Core.normalizeSubtitleText(item.translatedText));
          }
        }

        for (const block of batch) {
          const translatedText = translatedById.get(block.id);
          if (translatedText) {
            renderTranslation(block, translatedText);
          } else {
            renderTranslationError(block, "Translation missing for this block.");
          }
          translatedCount += 1;
        }

        showStatus(`Translating ${translatedCount}/${blocks.length} blocks...`, true);
      }

      state.translated = true;
      updateBallMode("done");
      showStatus(`Done. Added ${translatedCount} bilingual translations.`);
    } catch (error) {
      updateBallMode("error");
      const message = error && error.message ? error.message : String(error);
      for (const block of blocks) {
        if (block.container && block.container.dataset.ytbtState === "loading") {
          renderTranslationError(block, message);
        }
      }
      showStatus(`Translation failed: ${message}`, true);
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
      blocks.push({ id, element, sourceText: text });
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
    if (element.closest(SKIP_SELECTOR)) {
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
    if (!element || element.closest(SKIP_SELECTOR)) {
      return false;
    }
    if (element.closest("[data-ytbt-immersive-source]")) {
      return false;
    }
    if (isInSiteChromeHeader(element)) {
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
    return Boolean(header && !header.closest(CONTENT_SCOPE_SELECTOR));
  }

  function hasReadableDescendantBlock(element) {
    for (const descendant of element.querySelectorAll(READABLE_DESCENDANT_SELECTOR)) {
      if (descendant === element || descendant.closest(SKIP_SELECTOR)) {
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
    for (const injected of clone.querySelectorAll("[data-ytbt-immersive-translation]")) {
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
    if (!container) {
      return;
    }
    const text = container.querySelector(".ytbt-immersive-text");
    if (text) {
      text.textContent = translatedText;
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

  function makeBatches(blocks) {
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const block of blocks) {
      const textLength = block.sourceText.length;
      const wouldOverflow =
        current.length >= BATCH_SIZE ||
        (current.length > 0 && currentChars + textLength > BATCH_CHAR_LIMIT);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }

      current.push(block);
      currentChars += textLength;
    }

    if (current.length) {
      batches.push(current);
    }

    return batches;
  }

  async function translateBatch(batch) {
    const response = await sendMessage({
      type: "IMMERSIVE_TRANSLATE",
      pageUrl: location.href,
      items: batch.map((block) => ({
        id: block.id,
        sourceText: block.sourceText
      }))
    });

    if (!response || response.ok === false) {
      const error = response && response.errors && response.errors[0];
      throw new Error(error && error.message ? error.message : "Translation request failed.");
    }

    return Array.isArray(response.items) ? response.items : [];
  }

  function sendMessage(message) {
    return Core.sendRuntimeMessage(chrome.runtime, message, MESSAGE_TIMEOUT_MS);
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
