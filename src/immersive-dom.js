// Readable block selection and source-language filtering.
// Modules share only YTBTImmersive; startup runs last in immersive.js.
(function () {
  "use strict";
  const App = globalThis.YTBTImmersive;
  if (!App) return;
  const { Core, state } = App;

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
  const UI_SELECTOR = [
    "button",
    "input",
    "textarea",
    "select",
    "footer",
    "form",
    "[role='menu']",
    "[role='menubar']",
    "[role='menuitem']",
    "[role='button']",
    "[role='tab']",
    "[role='tablist']",
    ".dropdown-content"
  ].join(",");
  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "pre",
    "code",
    "[contenteditable='true']",
    "[translate='no']",
    "[aria-hidden='true']",
    "[data-ytbt-immersive-root]",
    "[data-ytbt-immersive-translation]"
  ].join(",");
  // Documentation callouts and page outlines are readable content, even when
  // their sites use the same semantic tags as global navigation/sidebar chrome.
  const TOC_SELECTOR = "#toc, #toc-side, .toc, .table-of-contents, [role='doc-toc'], [aria-label='Table of contents' i], #pagenav > #pagenav-content";
  const OUTLINE_DECORATION_SELECTOR = "#pagenav-content .page-number";
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
  function collectBlocks({ outlinesOnly = false } = {}) {
    const candidates = collectCandidateElements();
    const blocks = [];

    for (let element of candidates) {
      if (outlinesOnly && !element.closest(TOC_SELECTOR)) continue;
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

      element = App.prepareOutlineLabel(element);

      const id = `im${state.nextBlockId || 0}`;
      state.nextBlockId = (state.nextBlockId || 0) + 1;
      element.dataset.ytbtImmersiveSource = id;
      element.classList.add("ytbt-immersive-source");
      blocks.push({ id, element, sourceText: text, ...App.extractInlineFormatting(element) });
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
    // Skipping a menu's children is not enough: its visible wrapper can look
    // like a leaf block, and textContent still includes the entire hidden menu.
    // Reject that wrapper before either plain or formatted text is extracted.
    // Inline code is intentionally not a UI boundary; callouts/TOCs retain
    // their semantic exceptions through isExcludedFromTranslation.
    for (const descendant of element.querySelectorAll(`${UI_SELECTOR}, nav, aside, [role='navigation']`)) {
      if (isExcludedFromTranslation(descendant)) return false;
    }
    if (element.closest("[data-ytbt-immersive-source]") || element.querySelector("[data-ytbt-immersive-source]")) {
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
    if (element.closest(SKIP_SELECTOR) || element.closest(OUTLINE_DECORATION_SELECTOR)) {
      return true;
    }
    const toc = element.closest(TOC_SELECTOR);
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      // A document outline may use dropdown/menu semantics. Only its root
      // and actual links are content; controls and unrelated menus stay out.
      if (ancestor.matches(UI_SELECTOR) &&
          !(toc && ancestor === toc && ancestor.matches(".dropdown-content, [role='menu']")) &&
          !(toc && toc.contains(ancestor) && ancestor.matches("a[href][role='menuitem']"))) {
        return true;
      }
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
    if (element.closest("#pagenav-content")) {
      for (const number of clone.querySelectorAll(".page-number")) number.remove();
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
    if (!/\p{L}/u.test(text)) {
      return false;
    }
    if (/^https?:\/\//i.test(text) || /^[\d\s.,:;!?()[\]{}'"`~@#$%^&*_+=|\\/-]+$/.test(text)) {
      return false;
    }

    const preferences = state.runPreferences || state.preferences;
    const source = preferences.immersiveSourceLanguage;
    const target = preferences.immersiveTargetLanguage || preferences.targetLanguage;
    const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
    if (cjk.length >= 2) {
      // Auto detection should not retranslate paragraphs already in the target script.
      if (source === "auto" && target?.startsWith("zh") && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) && cjk.length > text.length / 2) return false;
      return isShortTextBlock(element) || cjk.length >= 4;
    }
    const words = text.match(/\p{L}[\p{L}'-]*/gu) || [];
    if (isShortTextBlock(element)) {
      return words.length >= 1 && text.length >= 2;
    }

    return text.length >= MIN_TEXT_LENGTH && words.length >= 4;
  }

  function isShortTextBlock(element) {
    return Boolean(
      element &&
        (element.matches(SHORT_TEXT_SELECTOR) ||
          (element.closest(TOC_SELECTOR) && element.matches("a[href], header, header span, .page-divider")) ||
          (element.closest(CALLOUT_SELECTOR) && element.closest(CALLOUT_TITLE_SELECTOR)) ||
          (element.closest(CONTENT_SCOPE_SELECTOR) && element.matches(SHORT_TEXT_CLASS_SELECTOR)))
    );
  }

  Object.assign(App, { TOC_SELECTOR, OUTLINE_DECORATION_SELECTOR, CALLOUT_SELECTOR, CALLOUT_TITLE_SELECTOR, collectBlocks });
})();
