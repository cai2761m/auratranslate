/*
 * AuraTranslate content script — player element tracking and native caption blocking
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

// --- Video element tracking, seeking, and render loop ---
function watchVideoElement() {
  const video = document.querySelector("video");
  if (video === state.video) {
    return;
  }

  if (state.video) {
    state.video.removeEventListener("seeked", handleSeek);
    state.video.removeEventListener("loadedmetadata", handleSeek);
  }

  state.video = video;
  if (state.video) {
    state.video.addEventListener("seeked", handleSeek);
    state.video.addEventListener("loadedmetadata", handleSeek);
  }
}

function handleSeek() {
  // A seek is also an explicit opportunity to recover undelivered requests.
  // Never reset completed/in-flight work or retry API/configuration failures.
  for (const cue of state.cues) {
    if (cue.status === "failed" && Core.isRuntimeConnectionError(cue.lastError)) {
      cue.status = "pending";
      cue.lastError = "";
    }
  }
  scheduleTranslations(getCurrentTimeMs(), true);
}

function getCurrentTimeMs() {
  const video = state.video || document.querySelector("video");
  if (!video || !Number.isFinite(video.currentTime)) {
    return 0;
  }
  return video.currentTime * 1000;
}

function getUrlVideoId() {
  try {
    return new URL(window.location.href).searchParams.get("v") || "";
  } catch (error) {
    return "";
  }
}

function syncVideoWithLocation() {
  const urlVideoId = getUrlVideoId();
  if (!urlVideoId || urlVideoId === state.videoId) {
    return;
  }

  const transcript =
    state.transcript ||
    (state.lastPlayerResponse && state.lastPlayerResponse.transcript) ||
    null;
  const trackFingerprint = makeStableTrackFingerprint(urlVideoId, null, transcript);

  resetVideoState(urlVideoId, null, trackFingerprint, transcript);
  state.lastPlayerResponse = null;
  setStatus("正在切换视频并读取字幕...");
  requestPlayerResponse();

  if (hasTranscriptApi(transcript)) {
    loadCaptionTrack(urlVideoId, null, trackFingerprint, transcript);
  }
}

function renderLoop() {
  syncVideoWithLocation();
  ensureOverlay();
  updateNativeCaptionBlocking();
  updateOverlay();
  requestAnimationFrame(renderLoop);
}


// --- Native caption overlay blocking ---
function startNativeCaptionBlocker() {
  if (state.nativeCaptionObserver) {
    return;
  }

  state.nativeCaptionObserver = new MutationObserver((mutations) => {
    if (!shouldBlockNativeCaptions()) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        hideNativeCaptionNodeTree(node);
      }
    }
  });

  const root = document.documentElement || document.body;
  if (root) {
    state.nativeCaptionObserver.observe(root, {
      childList: true,
      subtree: true
    });
  }
  updateNativeCaptionBlocking(true);
}

function updateNativeCaptionBlocking(force) {
  if (!force && Date.now() - state.lastNativeCaptionSweepAt < 250) {
    return;
  }
  state.lastNativeCaptionSweepAt = Date.now();

  const shouldBlock = shouldBlockNativeCaptions();
  document.documentElement.classList.toggle("ytbt-hide-native-captions", shouldBlock);
  if (shouldBlock) {
    restoreProtectedPlayerContainers();
    hideNativeCaptionNodeTree(document);
    if (!IS_DRIVE_PLAYER) {
      hideCaptionLikePlayerOverlays();
    }
  } else {
    restoreNativeCaptionNodes();
  }
}

function shouldBlockNativeCaptions() {
  return Boolean(state.settings.subtitleEnabled && state.cues.length);
}

function hideNativeCaptionNodeTree(root) {
  if (!root || !shouldBlockNativeCaptions()) {
    return;
  }

  const nodes = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches && root.matches(NATIVE_CAPTION_SELECTOR)) {
    nodes.push(root);
  }
  if (root.querySelectorAll) {
    nodes.push(...root.querySelectorAll(NATIVE_CAPTION_SELECTOR));
  }

  for (const node of nodes) {
    if (Core.isProtectedVideoContainer(node, state.overlay)) {
      continue;
    }
    node.dataset.ytbtNativeCaptionHidden = "true";
    node.style.setProperty("display", "none", "important");
    node.style.setProperty("visibility", "hidden", "important");
    node.style.setProperty("opacity", "0", "important");
    node.style.setProperty("pointer-events", "none", "important");
  }
}

function hideCaptionLikePlayerOverlays() {
  const player = findVideoPlayer();
  if (!player) {
    return;
  }

  const playerRect = player.getBoundingClientRect();
  if (!playerRect.width || !playerRect.height) {
    return;
  }

  const candidates = new Set([
    ...player.querySelectorAll("div, span, p"),
    ...document.querySelectorAll(
      "body div[style], body span[style], body p[style], body [class*='caption' i], body [class*='subtitle' i]"
    )
  ]);
  for (const node of candidates) {
    if (!isLikelyNativeCaptionOverlay(node, playerRect)) {
      continue;
    }
    node.dataset.ytbtNativeCaptionHidden = "true";
    node.style.setProperty("display", "none", "important");
    node.style.setProperty("visibility", "hidden", "important");
    node.style.setProperty("opacity", "0", "important");
    node.style.setProperty("pointer-events", "none", "important");
  }
}

function isLikelyNativeCaptionOverlay(node, playerRect) {
  if (!node || !shouldBlockNativeCaptions()) {
    return false;
  }
  if (Core.isProtectedVideoContainer(node, state.overlay)) {
    return false;
  }
  if (node.closest(".ytbt-overlay")) {
    return false;
  }
  if (node.closest("#masthead, ytd-app, ytd-watch-metadata, ytd-comments, ytd-engagement-panel-section-list-renderer") && !node.closest(".html5-video-player, #movie_player")) {
    return false;
  }
  if (node.closest(".ytp-chrome-bottom, .ytp-chrome-top, .ytp-gradient-bottom, .ytp-gradient-top, .ytp-progress-bar-container, .ytp-tooltip, .ytp-popup, .ytp-ce-element")) {
    return false;
  }
  if (node.querySelector("button, a, svg, input, textarea, select")) {
    return false;
  }

  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  if (text.length < 18) {
    return false;
  }

  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return false;
  }
  if (!rectOverlapsPlayer(rect, playerRect)) {
    return false;
  }
  if (rect.width < playerRect.width * 0.18 || rect.height < 12) {
    return false;
  }
  if (rect.bottom < playerRect.top + playerRect.height * 0.32) {
    return false;
  }

  const style = window.getComputedStyle(node);
  const positionLooksOverlay = style.position === "absolute" || style.position === "fixed";
  const highLayer = Number.parseInt(style.zIndex, 10);
  const fontSize = Number.parseFloat(style.fontSize);
  const hasCaptionishStyle =
    style.textShadow !== "none" ||
    style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
    style.webkitTextStrokeWidth !== "0px" ||
    textLooksLikeActiveCue(text);

  return (
    (positionLooksOverlay || textLooksLikeActiveCue(text)) &&
    (Number.isFinite(highLayer) ? highLayer >= 0 : true) &&
    Number.isFinite(fontSize) &&
    fontSize >= 12 &&
    hasCaptionishStyle
  );
}

function rectOverlapsPlayer(rect, playerRect) {
  const horizontallyOverlaps = rect.right > playerRect.left && rect.left < playerRect.right;
  const verticallyOverlaps = rect.bottom > playerRect.top + playerRect.height * 0.25 && rect.top < playerRect.bottom;
  return horizontallyOverlaps && verticallyOverlaps;
}

function textLooksLikeActiveCue(text) {
  const cue = Core.findCueAtTime(state.cues, getCurrentTimeMs());
  if (!cue) {
    return false;
  }

  const normalizedText = Core.normalizeSubtitleText(text).toLowerCase();
  const sourceText = Core.normalizeSubtitleText(cue.displaySourceText || cue.sourceText || "").toLowerCase();
  const translatedText = Core.normalizeSubtitleText(cue.translatedText || "").toLowerCase();

  return textPairLooksRelated(normalizedText, sourceText) || textPairLooksRelated(normalizedText, translatedText);
}

function textPairLooksRelated(left, right) {
  if (!left || !right) {
    return false;
  }

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length < 12) {
    return false;
  }

  return longer.includes(shorter.slice(0, Math.min(48, shorter.length)));
}

function restoreNativeCaptionNodes() {
  for (const node of document.querySelectorAll('[data-ytbt-native-caption-hidden="true"]')) {
    delete node.dataset.ytbtNativeCaptionHidden;
    node.style.removeProperty("display");
    node.style.removeProperty("visibility");
    node.style.removeProperty("opacity");
    node.style.removeProperty("pointer-events");
  }
}

function restoreProtectedPlayerContainers() {
  for (const node of document.querySelectorAll('[data-ytbt-native-caption-hidden="true"]')) {
    if (!Core.isProtectedVideoContainer(node, state.overlay)) {
      continue;
    }
    delete node.dataset.ytbtNativeCaptionHidden;
    node.style.removeProperty("display");
    node.style.removeProperty("visibility");
    node.style.removeProperty("opacity");
    node.style.removeProperty("pointer-events");
  }
}
