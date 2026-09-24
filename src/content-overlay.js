/*
 * AuraTranslate content script — subtitle overlay rendering and dragging
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

// --- Overlay construction, drag and touch handling ---
function ensureOverlay() {
  const player = findVideoPlayer();
  if (!player) {
    return null;
  }

  if (state.overlay && state.overlay.parentElement === player) {
    return state.overlay;
  }

  const overlay = state.overlay || document.createElement("div");
  if (!state.overlay) {
    overlay.className = "ytbt-overlay ytbt-no-cue ytbt-no-status";
    overlay.setAttribute("aria-live", "polite");
    overlay.dataset.ytbtVersion = chrome.runtime.getManifest().version;
    overlay.style.setProperty("--ytbt-font-scale", String(state.settings.fontScale));
    overlay.innerHTML = [
      '<div class="ytbt-lines">',
      '  <div class="ytbt-cn"></div>',
      '  <div class="ytbt-en"></div>',
      "</div>",
      '<div class="ytbt-status"></div>'
    ].join("");
    state.overlay = overlay;
    state.overlayParts = {
      cn: overlay.querySelector(".ytbt-cn"),
      en: overlay.querySelector(".ytbt-en"),
      status: overlay.querySelector(".ytbt-status")
    };
  } else {
    // Moving to a replacement/fullscreen player must retain the subtitle
    // nodes and their listeners, not recreate unbound drag surfaces.
    cancelOverlayDrag();
  }
  bindOverlayDragHandlers(overlay);
  player.appendChild(overlay);
  applySettings();
  return overlay;
}

function bindOverlayDragHandlers(overlay) {
  if (!overlay || overlay.dataset.ytbtDragBound === "true") {
    return;
  }

  overlay.dataset.ytbtDragBound = "true";
  for (const surface of overlay.querySelectorAll(".ytbt-lines, .ytbt-status")) {
    surface.addEventListener("pointerdown", handleOverlayPointerDown, true);
  }
  // Mobile player controls can sit above the subtitles in another layer.
  // Capture touches before the player's handlers and hit-test only the
  // visible subtitle surfaces; other player gestures stay untouched.
  window.addEventListener("touchstart", handleOverlayTouchStart, { capture: true, passive: false });
  window.addEventListener("contextmenu", handleOverlayContextMenu, true);
}

function findOverlayTouchSurface(clientX, clientY) {
  const overlay = state.overlay;
  if (!state.settings.subtitleEnabled || !overlay || overlay.hidden || !overlay.isConnected) {
    return null;
  }
  const player = getOverlayPlayer();
  const playerRect = player && player.getBoundingClientRect();
  if (!playerRect || clientX < playerRect.left || clientX > playerRect.right ||
      clientY < playerRect.top || clientY > playerRect.bottom) {
    return null;
  }
  for (const surface of overlay.querySelectorAll(".ytbt-lines, .ytbt-status")) {
    const rect = surface.getBoundingClientRect();
    const style = window.getComputedStyle(surface);
    if (style.display !== "none" && style.visibility !== "hidden" &&
        rect.width > 0 && rect.height > 0 && clientX >= rect.left &&
        clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return surface;
    }
  }
  return null;
}

function stopOverlayTouchEvent(event) {
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

function handleOverlayTouchStart(event) {
  if (state.overlayDrag.touchId != null || event.touches.length !== 1) {
    return;
  }
  const touch = event.changedTouches[0];
  if (!touch || !findOverlayTouchSurface(touch.clientX, touch.clientY)) {
    return;
  }
  stopOverlayTouchEvent(event);
  // Use a separate identity from PointerEvent ids. Firefox can emit both
  // streams for one finger; only the touch stream owns this gesture.
  beginOverlayDrag(`touch:${touch.identifier}`, touch.clientX, touch.clientY, null);
  state.overlayDrag.touchId = touch.identifier;
  window.addEventListener("touchmove", handleOverlayTouchMove, { capture: true, passive: false });
  window.addEventListener("touchend", handleOverlayTouchEnd, { capture: true, passive: false });
  window.addEventListener("touchcancel", handleOverlayTouchCancel, { capture: true, passive: false });
}

function activeOverlayTouch(event) {
  return Array.from(event.changedTouches).find((touch) => touch.identifier === state.overlayDrag.touchId);
}

function handleOverlayTouchMove(event) {
  const touch = activeOverlayTouch(event);
  if (!touch) return;
  stopOverlayTouchEvent(event);
  state.overlayDrag.lastClientX = touch.clientX;
  state.overlayDrag.lastClientY = touch.clientY;
  moveOverlayToPointer(touch.clientX, touch.clientY);
}

function handleOverlayTouchEnd(event) {
  const touch = activeOverlayTouch(event);
  if (!touch) return;
  stopOverlayTouchEvent(event);
  moveOverlayToPointer(touch.clientX, touch.clientY);
  saveOverlayPosition();
  cancelOverlayDrag();
}

function handleOverlayTouchCancel(event) {
  if (!activeOverlayTouch(event)) return;
  stopOverlayTouchEvent(event);
  cancelOverlayDrag();
}

function handleOverlayContextMenu(event) {
  if (state.overlayDrag.touchId != null) stopOverlayTouchEvent(event);
}

function handleOverlayPointerDown(event) {
  // Touch Events also prevent the player's separate touch/scroll handlers.
  // Keep Pointer Events for mice, pens and pointer-only touch environments.
  if (state.overlayDrag.touchId != null ||
      (event.pointerType === "touch" && "ontouchstart" in window)) {
    return;
  }
  if (!state.settings.subtitleEnabled || !state.overlay) {
    return;
  }
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  if (!event.target.closest(".ytbt-lines, .ytbt-status")) {
    return;
  }
  if (state.overlayDrag.pointerId != null) {
    cancelOverlayDrag();
  }

  event.preventDefault();
  event.stopPropagation();

  beginOverlayDrag(
    event.pointerId,
    event.clientX,
    event.clientY,
    event.currentTarget
  );

  const drag = state.overlayDrag;
  if (drag.captureTarget && typeof drag.captureTarget.setPointerCapture === "function") {
    try {
      drag.captureTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      // The document-level listeners below still keep dragging functional.
    }
  }

  document.addEventListener("pointermove", handleOverlayPointerMove, true);
  document.addEventListener("pointerup", handleOverlayPointerUp, true);
  document.addEventListener("pointercancel", handleOverlayPointerCancel, true);
  document.addEventListener("mouseup", handleOverlayMouseUpFallback, true);
}

function beginOverlayDrag(pointerId, clientX, clientY, captureTarget) {
  if (!state.overlay) {
    return false;
  }
  if (state.overlayDrag.pointerId != null) {
    cancelOverlayDrag();
  }

  const drag = state.overlayDrag;
  drag.pointerId = pointerId;
  drag.captureTarget = captureTarget || null;
  drag.active = true;
  drag.lastClientX = clientX;
  drag.lastClientY = clientY;
  setOverlayDragOffsets(clientX, clientY);
  state.overlay.classList.add("ytbt-dragging");
  moveOverlayToPointer(clientX, clientY);
  return true;
}

function beginRelayedOverlayDrag(data) {
  if (!state.settings.subtitleEnabled || !state.overlay) {
    return;
  }

  const point = readRelayedPointer(data);
  if (!point) {
    return;
  }
  beginOverlayDrag(point.pointerId, point.clientX, point.clientY, null);
}

function moveRelayedOverlayDrag(data) {
  const point = readRelayedPointer(data);
  if (!point || state.overlayDrag.pointerId !== point.pointerId) {
    return;
  }

  state.overlayDrag.lastClientX = point.clientX;
  state.overlayDrag.lastClientY = point.clientY;
  moveOverlayToPointer(point.clientX, point.clientY);
}

function endRelayedOverlayDrag(data, savePosition) {
  const point = readRelayedPointer(data);
  if (!point || state.overlayDrag.pointerId !== point.pointerId) {
    return;
  }

  if (savePosition && state.overlayDrag.active) {
    saveOverlayPosition();
  }
  cancelOverlayDrag();
}

function readRelayedPointer(data) {
  const pointerId = Number(data && data.pointerId);
  const clientX = Number(data && data.clientX);
  const clientY = Number(data && data.clientY);
  if (
    !Number.isFinite(pointerId) ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  ) {
    return null;
  }
  return { pointerId, clientX, clientY };
}

function setOverlayDragOffsets(clientX, clientY) {
  if (!state.overlay) {
    return;
  }

  const overlayRect = state.overlay.getBoundingClientRect();
  state.overlayDrag.offsetX = clientX - overlayRect.left;
  state.overlayDrag.offsetY = clientY - overlayRect.top;
}

function handleOverlayPointerMove(event) {
  const drag = state.overlayDrag;
  if (drag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  drag.lastClientX = event.clientX;
  drag.lastClientY = event.clientY;

  if (!drag.active) {
    return;
  }

  moveOverlayToPointer(event.clientX, event.clientY);
}

function handleOverlayPointerUp(event) {
  if (state.overlayDrag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const wasDragging = state.overlayDrag.active;
  if (wasDragging) {
    saveOverlayPosition();
  }
  cancelOverlayDrag();
}

function handleOverlayPointerCancel(event) {
  if (event && state.overlayDrag.pointerId !== event.pointerId) {
    return;
  }
  cancelOverlayDrag();
}

function handleOverlayMouseUpFallback(event) {
  if (state.overlayDrag.pointerId == null || state.overlayDrag.touchId != null) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (state.overlayDrag.active) {
    saveOverlayPosition();
  }
  cancelOverlayDrag();
}

function moveOverlayToPointer(clientX, clientY) {
  const player = getOverlayPlayer();
  if (!player || !state.overlay) {
    return;
  }

  const playerRect = player.getBoundingClientRect();
  const overlayRect = state.overlay.getBoundingClientRect();
  if (!playerRect.width || !playerRect.height || !overlayRect.width || !overlayRect.height) {
    return;
  }

  const centerX = clientX - state.overlayDrag.offsetX + overlayRect.width / 2;
  const centerY = clientY - state.overlayDrag.offsetY + overlayRect.height / 2;
  const minX = playerRect.left + overlayRect.width / 2 + DRAG_EDGE_PADDING_PX;
  const maxX = playerRect.right - overlayRect.width / 2 - DRAG_EDGE_PADDING_PX;
  const minY = playerRect.top + overlayRect.height / 2 + DRAG_EDGE_PADDING_PX;
  const maxY = playerRect.bottom - overlayRect.height / 2 - DRAG_EDGE_PADDING_PX;
  const clampedX = clamp(centerX, Math.min(minX, maxX), Math.max(minX, maxX));
  const clampedY = clamp(centerY, Math.min(minY, maxY), Math.max(minY, maxY));

  state.settings.subtitlePosition = {
    xPct: ((clampedX - playerRect.left) / playerRect.width) * 100,
    yPct: ((clampedY - playerRect.top) / playerRect.height) * 100
  };
  applyOverlayPosition();
}

async function saveOverlayPosition() {
  const position = normalizeSubtitlePosition(state.settings.subtitlePosition);
  if (!position) {
    return;
  }
  state.settings.subtitlePosition = position;
  await storageSet({ subtitlePosition: position });
}

function cancelOverlayDrag() {
  const drag = state.overlayDrag;
  if (
    drag.captureTarget &&
    drag.pointerId != null &&
    typeof drag.captureTarget.hasPointerCapture === "function" &&
    typeof drag.captureTarget.releasePointerCapture === "function"
  ) {
    try {
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch (error) {
      // Pointer capture may already have been released by the browser.
    }
  }

  document.removeEventListener("pointermove", handleOverlayPointerMove, true);
  document.removeEventListener("pointerup", handleOverlayPointerUp, true);
  document.removeEventListener("pointercancel", handleOverlayPointerCancel, true);
  document.removeEventListener("mouseup", handleOverlayMouseUpFallback, true);
  window.removeEventListener("touchmove", handleOverlayTouchMove, true);
  window.removeEventListener("touchend", handleOverlayTouchEnd, true);
  window.removeEventListener("touchcancel", handleOverlayTouchCancel, true);

  if (state.overlay) {
    state.overlay.classList.remove("ytbt-dragging");
  }

  drag.pointerId = null;
  drag.touchId = null;
  drag.captureTarget = null;
  drag.active = false;
}

function applyOverlayPosition() {
  if (!state.overlay) {
    return;
  }

  const position = normalizeSubtitlePosition(state.settings.subtitlePosition);
  if (!position) {
    state.overlay.style.left = "50%";
    state.overlay.style.top = "";
    // Let the mobile/fullscreen CSS choose the default control-bar offset.
    state.overlay.style.bottom = "";
    state.overlay.style.transform = "translateX(-50%)";
    return;
  }

  state.overlay.style.left = `${position.xPct}%`;
  state.overlay.style.top = `${position.yPct}%`;
  state.overlay.style.bottom = "auto";
  state.overlay.style.transform = "translate(-50%, -50%)";
}

function publishDriveOverlayGeometry() {
  if (!IS_DRIVE_PLAYER || window.parent === window || !state.overlay) {
    return;
  }

  const now = Date.now();
  const rects = Array.from(
    state.overlay.querySelectorAll(".ytbt-lines, .ytbt-status")
  ).map((surface) => {
    const rect = surface.getBoundingClientRect();
    const style = window.getComputedStyle(surface);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };
  }).filter(Boolean);
  const signature = JSON.stringify(rects.map((rect) => (
    [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10)
  )));

  if (
    signature === state.lastDriveOverlayGeometrySignature &&
    now - state.lastDriveOverlayGeometryAt < DRIVE_OVERLAY_GEOMETRY_REFRESH_MS
  ) {
    return;
  }

  state.lastDriveOverlayGeometryAt = now;
  state.lastDriveOverlayGeometrySignature = signature;
  window.parent.postMessage(
    {
      channel: DRIVE_CHANNEL,
      type: "DRIVE_OVERLAY_GEOMETRY",
      version: chrome.runtime.getManifest().version,
      rects
    },
    "https://drive.google.com"
  );
}

function getOverlayPlayer() {
  return (
    (state.overlay && state.overlay.parentElement && state.overlay.parentElement.closest(".html5-video-player, #movie_player")) ||
    findVideoPlayer()
  );
}

function findVideoPlayer() {
  return document.querySelector(".html5-video-player") ||
    document.querySelector("#movie_player");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateOverlay() {
  const overlay = state.overlay;
  const parts = state.overlayParts;
  if (!overlay || !parts) {
    return;
  }

  if (!state.settings.subtitleEnabled) {
    overlay.hidden = true;
    return;
  }

  const timeMs = getCurrentTimeMs();
  const cue = Core.findCueAtTime(state.cues, timeMs);
  const hasCue = Boolean(cue);
  const statusText = hasCue ? "" : state.statusText;

  overlay.hidden = false;
  overlay.classList.toggle("ytbt-no-cue", !hasCue);
  overlay.classList.toggle("ytbt-no-status", !statusText);
  overlay.classList.toggle("ytbt-loading", hasCue && cue.status !== "translated");

  if (hasCue) {
    parts.cn.textContent = cue.translatedText || fallbackTextForCue(cue);
    parts.en.textContent = cue.displaySourceText || cue.sourceText || "";

    if ((cue.status === "pending" || cue.status === "unprepared") && Date.now() - state.lastUrgentScheduleAt > URGENT_RESCHEDULE_MS) {
      state.lastUrgentScheduleAt = Date.now();
      scheduleTranslations(timeMs, true);
    }
  } else {
    parts.cn.textContent = "";
    parts.en.textContent = "";
  }

  parts.status.textContent = statusText;
}


// --- Overlay cue text and rendering ---
function fallbackTextForCue(cue) {
  if (!hasApiKey()) {
    return missingApiConfigText();
  }
  if (cue.status === "failed") {
    return formatCueFailureText(cue.lastError);
  }
  if (state.preparationBlocked) return state.statusText;
  if (cue.status === "unprepared") return "正在准备当前片段字幕...";
  return "翻译中...";
}
