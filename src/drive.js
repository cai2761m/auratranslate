(function bridgeGoogleDriveTranscript() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const CHANNEL = "__ytbt_drive_transcript__";
  const PLAYER_ORIGIN = "https://youtube.googleapis.com";
  const TRANSCRIPT_WAIT_MS = 15000;
  const TRANSCRIPT_SETTLE_MS = 500;
  const RETRY_DELAY_MS = 5000;
  const TRANSCRIPT_LABEL_RE =
    /transcript|transcription|转写|轉寫|转录|轉錄|文字记录|文字記錄|文字起こし|텍스트 변환/i;
  const CLOSE_LABEL_RE = /close|关闭|關閉|閉じる|닫기/i;
  const TIME_LABEL_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  const state = {
    fileId: "",
    payload: null,
    loadingFileId: "",
    nextAttemptAt: 0,
    statusMessage: ""
  };

  init();

  function init() {
    window.addEventListener("message", handlePlayerMessage);
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
    if (!data || data.channel !== CHANNEL || data.type !== "REQUEST_DRIVE_TRANSCRIPT") {
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
