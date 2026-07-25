(function bridgeGoogleDriveTranscript() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const CHANNEL = "__ytbt_drive_transcript__";
  const PLAYER_ORIGIN = "https://youtube.googleapis.com";
  const TRANSCRIPT_WAIT_MS = 15000;
  const TRANSCRIPT_SETTLE_MS = 500;
  const RETRY_DELAY_MS = 5000;
  const OVERLAY_GEOMETRY_MAX_AGE_MS = 5000;
  const DRAG_CLICK_SUPPRESSION_MS = 750;
  const TRANSCRIPT_LABEL_RE =
    /transcript|transcription|转写|轉寫|转录|轉錄|文字记录|文字記錄|文字起こし|텍스트 변환/i;
  const CLOSE_LABEL_RE = /close|关闭|關閉|閉じる|닫기/i;
  const TIME_LABEL_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  const state = {
    fileId: "",
    payload: null,
    loadingFileId: "",
    nextAttemptAt: 0,
    statusMessage: "",
    overlaySource: null,
    overlayRects: [],
    overlayGeometryAt: 0,
    overlayVersion: "",
    suppressClickUntil: 0,
    overlayDrag: {
      pointerId: null,
      playerTarget: null,
      captureTarget: null
    }
  };

  init();

  function init() {
    window.addEventListener("message", handlePlayerMessage);
    window.addEventListener("pointerdown", handleOverlayPointerDown, true);
    window.addEventListener("pointermove", handleOverlayPointerMove, true);
    window.addEventListener("pointerup", handleOverlayPointerUp, true);
    window.addEventListener("pointercancel", handleOverlayPointerCancel, true);
    window.addEventListener("click", handleOverlayClick, true);
    syncDriveFile();
    setInterval(syncDriveFile, 1500);
  }

  function getDriveFileId() {
    const pathMatch = window.location.pathname.match(/\/file\/d\/([^/]+)/);
    if (pathMatch) {
      return decodeURIComponent(pathMatch[1]);
    }

    try {
      return new URL(window.location.href).searchParams.get("id") || "";
    } catch (error) {
      return "";
    }
  }

  function getPlayerFrames() {
    return Array.from(document.querySelectorAll("iframe")).filter((frame) => {
      try {
        const url = new URL(frame.src);
        return url.origin === PLAYER_ORIGIN && url.pathname.startsWith("/embed");
      } catch (error) {
        return false;
      }
    });
  }

  function isDrivePlayerSource(source) {
    return getPlayerFrames().some((frame) => frame.contentWindow === source);
  }

  function handlePlayerMessage(event) {
    if (
      event.origin !== PLAYER_ORIGIN ||
      !isDrivePlayerSource(event.source)
    ) {
      return;
    }

    const data = event.data;
    if (!data || data.channel !== CHANNEL) {
      return;
    }

    if (data.type === "DRIVE_OVERLAY_GEOMETRY") {
      updateOverlayGeometry(event.source, data);
      return;
    }

    if (data.type !== "REQUEST_DRIVE_TRANSCRIPT") {
      return;
    }

    if (state.payload) {
      postToPlayerFrame(event.source, state.payload);
      return;
    }

    if (state.statusMessage) {
      postStatusToPlayerFrame(event.source, state.statusMessage);
    }
    syncDriveFile();
  }

  function syncDriveFile() {
    const fileId = getDriveFileId();
    if (!fileId) {
      return;
    }

    if (fileId !== state.fileId) {
      state.fileId = fileId;
      state.payload = null;
      state.loadingFileId = "";
      state.nextAttemptAt = 0;
      state.statusMessage = "";
      state.overlaySource = null;
      state.overlayRects = [];
      state.overlayGeometryAt = 0;
      state.overlayVersion = "";
      cancelOverlayDrag(false);
    }

    if (state.payload) {
      return;
    }

    if (
      state.loadingFileId === fileId ||
      Date.now() < state.nextAttemptAt
    ) {
      return;
    }

    loadDriveTranscript(fileId);
  }

  function updateOverlayGeometry(source, data) {
    const rects = Array.isArray(data.rects)
      ? data.rects.map(normalizeOverlayRect).filter(Boolean).slice(0, 4)
      : [];
    state.overlaySource = source;
    state.overlayRects = rects;
    state.overlayGeometryAt = Date.now();
    state.overlayVersion = String(data.version || "");
  }

  function normalizeOverlayRect(rect) {
    const x = Number(rect && rect.x);
    const y = Number(rect && rect.y);
    const width = Number(rect && rect.width);
    const height = Number(rect && rect.height);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    return { x, y, width, height };
  }

  function handleOverlayPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const hit = findOverlayHit(event.clientX, event.clientY);
    if (!hit) {
      return;
    }

    cancelOverlayDrag(false);
    stopDrivePointerEvent(event);
    state.suppressClickUntil = Date.now() + DRAG_CLICK_SUPPRESSION_MS;

    const drag = state.overlayDrag;
    drag.pointerId = event.pointerId;
    drag.playerTarget = hit.frame.contentWindow;
    drag.captureTarget = event.target;

    if (drag.captureTarget && typeof drag.captureTarget.setPointerCapture === "function") {
      try {
        drag.captureTarget.setPointerCapture(event.pointerId);
      } catch (error) {
        // Window-level listeners continue receiving the usual pointer stream.
      }
    }

    postOverlayPointer("DRIVE_OVERLAY_POINTER_DOWN", event, hit.frame);
  }

  function handleOverlayPointerMove(event) {
    const drag = state.overlayDrag;
    if (drag.pointerId !== event.pointerId || !drag.playerTarget) {
      return;
    }

    const frame = findPlayerFrameBySource(drag.playerTarget);
    if (!frame) {
      cancelOverlayDrag(true);
      return;
    }

    stopDrivePointerEvent(event);
    postOverlayPointer("DRIVE_OVERLAY_POINTER_MOVE", event, frame);
  }

  function handleOverlayPointerUp(event) {
    const drag = state.overlayDrag;
    if (drag.pointerId !== event.pointerId || !drag.playerTarget) {
      return;
    }

    const frame = findPlayerFrameBySource(drag.playerTarget);
    stopDrivePointerEvent(event);
    state.suppressClickUntil = Date.now() + DRAG_CLICK_SUPPRESSION_MS;
    if (frame) {
      postOverlayPointer("DRIVE_OVERLAY_POINTER_UP", event, frame);
    }
    cancelOverlayDrag(false);
  }

  function handleOverlayPointerCancel(event) {
    if (state.overlayDrag.pointerId !== event.pointerId) {
      return;
    }
    stopDrivePointerEvent(event);
    cancelOverlayDrag(true);
  }

  function handleOverlayClick(event) {
    if (Date.now() >= state.suppressClickUntil) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function findOverlayHit(clientX, clientY) {
    if (
      !state.overlaySource ||
      !state.overlayRects.length ||
      Date.now() - state.overlayGeometryAt > OVERLAY_GEOMETRY_MAX_AGE_MS
    ) {
      return null;
    }

    const frame = findPlayerFrameBySource(state.overlaySource);
    if (!frame) {
      return null;
    }

    const frameRect = frame.getBoundingClientRect();
    const localX = clientX - frameRect.left;
    const localY = clientY - frameRect.top;
    const inside = state.overlayRects.some((rect) => (
      localX >= rect.x &&
      localX <= rect.x + rect.width &&
      localY >= rect.y &&
      localY <= rect.y + rect.height
    ));
    return inside ? { frame, localX, localY } : null;
  }

  function findPlayerFrameBySource(source) {
    return getPlayerFrames().find((frame) => frame.contentWindow === source) || null;
  }

  function postOverlayPointer(type, event, frame) {
    const frameRect = frame.getBoundingClientRect();
    postToPlayerFrame(frame.contentWindow, {
      channel: CHANNEL,
      type,
      pointerId: event.pointerId,
      clientX: event.clientX - frameRect.left,
      clientY: event.clientY - frameRect.top
    });
  }

  function stopDrivePointerEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function cancelOverlayDrag(notifyPlayer) {
    const drag = state.overlayDrag;
    if (notifyPlayer && drag.playerTarget && drag.pointerId != null) {
      postToPlayerFrame(drag.playerTarget, {
        channel: CHANNEL,
        type: "DRIVE_OVERLAY_POINTER_CANCEL",
        pointerId: drag.pointerId,
        clientX: 0,
        clientY: 0
      });
    }

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
        // The browser may already have released capture after pointerup.
      }
    }

    drag.pointerId = null;
    drag.playerTarget = null;
    drag.captureTarget = null;
  }

  async function loadDriveTranscript(fileId) {
    state.loadingFileId = fileId;
    setStatus("正在读取 Google Drive 转写字幕...");
    let openedByExtension = false;

    try {
      let entries = findTranscriptEntries();
      if (!entries.length) {
        const transcriptButton = findTranscriptButton();
        if (!transcriptButton) {
          throw new Error("这个 Google Drive 视频没有可用的转写内容");
        }

        transcriptButton.click();
        openedByExtension = true;
        entries = await waitForTranscriptEntries();
      }

      const items = entries.map(readTranscriptEntry).filter(Boolean);
      const cues = Core.parseGoogleDriveTranscriptItems(items);
      if (!cues.length) {
        throw new Error("Google Drive 转写内容为空");
      }

      if (fileId !== state.fileId) {
        return;
      }

      const signature = Core.fingerprintText(
        items.map((item) => `${item.startMs}:${item.sourceText}`).join("\n")
      );
      state.payload = {
        channel: CHANNEL,
        type: "DRIVE_TRANSCRIPT",
        fileId,
        signature,
        cues
      };
      state.statusMessage = "";
      state.nextAttemptAt = 0;
      broadcast(state.payload);
    } catch (error) {
      if (fileId !== state.fileId) {
        return;
      }
      const message = error && error.message ? error.message : String(error);
      setStatus(message);
      state.nextAttemptAt = Date.now() + RETRY_DELAY_MS;
    } finally {
      if (openedByExtension) {
        closeTranscriptPanel();
      }
      if (state.loadingFileId === fileId) {
        state.loadingFileId = "";
      }
    }
  }

  function findTranscriptButton() {
    const candidates = Array.from(document.querySelectorAll("button[aria-label]"));
    return candidates.find((button) => (
      TRANSCRIPT_LABEL_RE.test(button.getAttribute("aria-label") || "") &&
      !button.closest('[role="complementary"]')
    )) || document.querySelector('button[jsname="QzTKac"]');
  }

  function findTranscriptEntries() {
    return Array.from(
      document.querySelectorAll('div[role="button"][data-timestamp]')
    ).filter((entry) => Boolean(readTranscriptEntry(entry)));
  }

  function readTranscriptEntry(entry) {
    const startMs = Number(entry && entry.getAttribute("data-timestamp"));
    if (!Number.isFinite(startMs) || startMs < 0) {
      return null;
    }

    const directTimestampChildren = Array.from(entry.children || []).filter((child) => (
      child.tagName === "DIV" &&
      child.getAttribute("data-timestamp") === entry.getAttribute("data-timestamp")
    ));
    const sourceNode = directTimestampChildren.find((child) => {
      const text = Core.normalizeSubtitleText(child.textContent || "");
      return text && !TIME_LABEL_RE.test(text);
    });
    const sourceText = Core.normalizeSubtitleText(sourceNode && sourceNode.textContent);
    return sourceText ? { startMs, sourceText } : null;
  }

  function waitForTranscriptEntries() {
    return new Promise((resolve, reject) => {
      const existing = findTranscriptEntries();
      if (existing.length) {
        resolve(existing);
        return;
      }

      let settled = false;
      let settleTimer = null;
      let lastEntrySignature = "";
      const finishIfReady = () => {
        const entries = findTranscriptEntries();
        if (!entries.length || settled) {
          return;
        }

        const lastEntry = entries[entries.length - 1];
        const entrySignature = `${entries.length}:${lastEntry.getAttribute("data-timestamp") || ""}`;
        if (entrySignature === lastEntrySignature && settleTimer) {
          return;
        }
        lastEntrySignature = entrySignature;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          const stableEntries = findTranscriptEntries();
          if (!stableEntries.length || settled) {
            return;
          }
          const stableLastEntry = stableEntries[stableEntries.length - 1];
          const stableSignature = `${stableEntries.length}:${stableLastEntry.getAttribute("data-timestamp") || ""}`;
          if (stableSignature !== lastEntrySignature) {
            settleTimer = null;
            finishIfReady();
            return;
          }
          settled = true;
          clearTimeout(timeout);
          observer.disconnect();
          resolve(stableEntries);
        }, TRANSCRIPT_SETTLE_MS);
      };
      const observer = new MutationObserver(() => {
        finishIfReady();
      });
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(settleTimer);
        observer.disconnect();
        reject(new Error("等待 Google Drive 转写内容超时"));
      }, TRANSCRIPT_WAIT_MS);

      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
      finishIfReady();
    });
  }

  function closeTranscriptPanel() {
    const entry = findTranscriptEntries()[0];
    const panel = entry && entry.closest('[role="complementary"][aria-label]');
    if (!panel) {
      return;
    }

    const buttons = Array.from(panel.querySelectorAll("button[aria-label]"));
    const closeButton = buttons.find((button) => (
      !button.hasAttribute("data-timestamp") &&
      CLOSE_LABEL_RE.test(button.getAttribute("aria-label") || "")
    ));
    if (closeButton) {
      closeButton.click();
    }
  }

  function setStatus(message) {
    state.statusMessage = String(message || "");
    broadcast({
      channel: CHANNEL,
      type: "DRIVE_TRANSCRIPT_STATUS",
      fileId: state.fileId,
      message: state.statusMessage
    });
  }

  function broadcast(message) {
    for (const frame of getPlayerFrames()) {
      postToPlayerFrame(frame.contentWindow, message);
    }
  }

  function postStatusToPlayerFrame(target, message) {
    postToPlayerFrame(target, {
      channel: CHANNEL,
      type: "DRIVE_TRANSCRIPT_STATUS",
      fileId: state.fileId,
      message
    });
  }

  function postToPlayerFrame(target, message) {
    try {
      target.postMessage(message, PLAYER_ORIGIN);
    } catch (error) {
      // The player iframe can be replaced while Drive switches files.
    }
  }
})();
