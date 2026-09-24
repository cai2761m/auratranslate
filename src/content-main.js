/*
 * AuraTranslate content script — settings wiring, player messages, and bootstrap
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

// --- Startup ---
async function init() {
  await loadSettings();
  state.settingsLoaded = true;
  applySettings();
  if (IS_DRIVE_PLAYER) {
    bindDrivePlayerMessages();
    requestDriveTranscript();
    setInterval(requestDriveTranscript, 2000);
    setInterval(publishDriveOverlayGeometry, DRIVE_OVERLAY_GEOMETRY_INTERVAL_MS);
  } else if (state.pendingPlayerResponse) {
    const pendingPlayerResponse = state.pendingPlayerResponse;
    state.pendingPlayerResponse = null;
    handlePlayerResponse(pendingPlayerResponse);
  } else {
    requestPlayerResponse();
  }
  bindStorageChanges();
  startNativeCaptionBlocker();
  setInterval(watchVideoElement, 1000);
  setInterval(() => updateNativeCaptionBlocking(true), 500);
  setInterval(() => {
    if (state.cues.length) {
      scheduleTranslations(getCurrentTimeMs(), false);
    }
  }, 5000);
  requestAnimationFrame(renderLoop);
}


// --- Settings loading and normalization ---
async function loadSettings() {
  const stored = await storageGet(Core.DEFAULT_SETTINGS);
  state.settings = normalizeSettings(stored);
}

function normalizeSettings(settings) {
  const merged = Object.assign({}, Core.DEFAULT_SETTINGS, settings || {});
  merged.fontScale = Core.normalizeFontScale(merged.fontScale);
  merged.subtitleEnabled = merged.subtitleEnabled !== false;
  merged.subtitleTranslationMode = merged.subtitleTranslationMode === "full" ? "full" : "economy";
  merged.subtitleLookAheadMinutes = [1, 2, 3].includes(Number(merged.subtitleLookAheadMinutes))
    ? Number(merged.subtitleLookAheadMinutes) : 2;
  merged.llmSentenceSegmentationEnabled = merged.llmSentenceSegmentationEnabled !== false;
  merged.showOriginalTechnicalTerms = merged.showOriginalTechnicalTerms !== false;
  merged.targetLanguage = merged.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
  merged.sourceLanguage = merged.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
  merged.subtitlePosition = normalizeSubtitlePosition(merged.subtitlePosition);
  return merged;
}

function normalizeSubtitlePosition(position) {
  if (!position || typeof position !== "object") {
    return null;
  }

  const xPct = Number(position.xPct);
  const yPct = Number(position.yPct);
  if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) {
    return null;
  }

  return {
    xPct: Math.min(98, Math.max(2, xPct)),
    yPct: Math.min(96, Math.max(4, yPct))
  };
}


// --- Page bridge, storage changes, and player responses ---
function bindStorageChanges() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    let changed = false;
    for (const key of Object.keys(Core.DEFAULT_SETTINGS)) {
      if (changes[key]) {
        state.settings[key] = changes[key].newValue;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    state.settings = normalizeSettings(state.settings);
    applySettings();

    const realtimeApiChanged = Boolean(
      changes.deepseekApiKey ||
      changes.translationProvider ||
      changes.translationApiKey ||
      changes.translationBaseUrl ||
      changes.translationModel ||
      changes.translationJsonResponse
    );
    const needsSentenceSegmentationReload = Boolean(
      changes.llmSentenceSegmentationEnabled ||
      changes.sourceLanguage ||
      changes.targetLanguage ||
      changes.asrCorrectionEnabled ||
      changes.showOriginalTechnicalTerms ||
      realtimeApiChanged || changes.cacheVersion
    );

    if (needsSentenceSegmentationReload && state.driveTranscriptPayload) {
      const driveTranscriptPayload = state.driveTranscriptPayload;
      resetVideoState("", null, "");
      if (state.settings.subtitleEnabled) {
        handleDriveTranscript(driveTranscriptPayload);
      }
      return;
    }

    if (needsSentenceSegmentationReload && state.lastPlayerResponse) {
      const playerResponse = state.lastPlayerResponse;
      resetVideoState("", null, "");
      if (state.settings.subtitleEnabled) {
        handlePlayerResponse(playerResponse);
      }
      return;
    }

    if (changes.subtitleTranslationMode || changes.subtitleLookAheadMinutes || changes.subtitleEnabled) {
      state.queue = [];
      scheduleTranslations(getCurrentTimeMs(), true);
    }

    if (
      realtimeApiChanged ||
      changes.targetLanguage ||
      changes.sourceLanguage ||
      changes.asrCorrectionEnabled ||
      changes.showOriginalTechnicalTerms ||
      changes.llmSentenceSegmentationEnabled ||
      changes.cacheVersion
    ) {
      for (const cue of state.cues) {
        cue.status = "pending";
        cue.translatedText = "";
      }
      state.queue = [];
      state.inFlight.clear();
      scheduleTranslations(getCurrentTimeMs(), true);
    }

    if (changes.subtitleEnabled && state.settings.subtitleEnabled && state.lastPlayerResponse) {
      handlePlayerResponse(state.lastPlayerResponse);
    } else if (
      changes.subtitleEnabled &&
      state.settings.subtitleEnabled &&
      state.driveTranscriptPayload
    ) {
      handleDriveTranscript(state.driveTranscriptPayload);
    }
  });
}

function applySettings() {
  document.documentElement.classList.toggle(
    "ytbt-hide-native-captions",
    shouldBlockNativeCaptions()
  );
  updateNativeCaptionBlocking(true);

  if (state.overlay) {
    state.overlay.style.setProperty("--ytbt-font-scale", String(state.settings.fontScale));
    state.overlay.hidden = !state.settings.subtitleEnabled;
    applyOverlayPosition();
  }
}

function injectPageBridge() {
  if (state.bridgeInjected) {
    return;
  }

  const root = document.documentElement || document.head || document.body;
  if (!root) {
    setTimeout(injectPageBridge, 50);
    return;
  }

  state.bridgeInjected = true;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/page-bridge.js");
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  root.appendChild(script);
}

function requestPlayerResponse() {
  window.postMessage(
    {
      channel: CHANNEL,
      type: "REQUEST_PLAYER_RESPONSE"
    },
    window.location.origin
  );
}

function bindPageMessages() {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== "PLAYER_RESPONSE") {
      return;
    }

    resolveNativeCaptionWaiters(data);
    if (!state.settingsLoaded) {
      state.pendingPlayerResponse = data;
      return;
    }
    handlePlayerResponse(data);
  });
}

function resolveNativeCaptionWaiters(payload) {
  if (!state.nativeCaptionWaiters.size) {
    return;
  }

  const videoId = String(payload && payload.videoId || "");
  const tracks = Array.isArray(payload && payload.captionTracks) ? payload.captionTracks : [];
  for (const waiter of Array.from(state.nativeCaptionWaiters)) {
    if (waiter.videoId && videoId && waiter.videoId !== videoId) {
      continue;
    }
    const track = tracks.find((candidate) => (
      candidate &&
      candidate.capturedText &&
      isMatchingCaptionTrack(candidate, waiter.track)
    ));
    if (!track) {
      continue;
    }
    state.nativeCaptionWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(track);
  }
}

function isMatchingCaptionTrack(candidate, requested) {
  const candidateLanguage = String(candidate && candidate.languageCode || "").toLowerCase();
  const requestedLanguage = String(requested && requested.languageCode || "").toLowerCase();
  if (requestedLanguage && candidateLanguage && requestedLanguage !== candidateLanguage) {
    return false;
  }

  const candidateKind = String(candidate && candidate.kind || "").toLowerCase() ||
    (String(candidate && candidate.vssId || "").startsWith("a.") ? "asr" : "");
  const requestedKind = String(requested && requested.kind || "").toLowerCase() ||
    (String(requested && requested.vssId || "").startsWith("a.") ? "asr" : "");
  return !requestedKind || !candidateKind || requestedKind === candidateKind;
}

function bindDrivePlayerMessages() {
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== "https://drive.google.com"
    ) {
      return;
    }

    const data = event.data;
    if (!data || data.channel !== DRIVE_CHANNEL) {
      return;
    }

    if (data.type === "DRIVE_TRANSCRIPT") {
      handleDriveTranscript(data).catch((error) => {
        setStatus(`Google Drive 字幕读取失败：${simplifyTranslationError(error && error.message ? error.message : error)}`);
      });
    } else if (data.type === "DRIVE_TRANSCRIPT_STATUS") {
      const statusFileId = String(data.fileId || "");
      if (statusFileId && statusFileId !== state.videoId) {
        state.driveTranscriptPayload = null;
        resetVideoState(statusFileId, null, "", null);
      }
      setStatus(String(data.message || ""));
    } else if (data.type === "DRIVE_OVERLAY_POINTER_DOWN") {
      beginRelayedOverlayDrag(data);
    } else if (data.type === "DRIVE_OVERLAY_POINTER_MOVE") {
      moveRelayedOverlayDrag(data);
    } else if (data.type === "DRIVE_OVERLAY_POINTER_UP") {
      endRelayedOverlayDrag(data, true);
    } else if (data.type === "DRIVE_OVERLAY_POINTER_CANCEL") {
      endRelayedOverlayDrag(data, false);
    }
  });
}

function requestDriveTranscript() {
  if (!IS_DRIVE_PLAYER || window.parent === window) {
    return;
  }

  window.parent.postMessage(
    {
      channel: DRIVE_CHANNEL,
      type: "REQUEST_DRIVE_TRANSCRIPT"
    },
    "https://drive.google.com"
  );
}

async function handleDriveTranscript(payload) {
  if (!state.settings.subtitleEnabled) {
    setStatus("");
    return;
  }

  const videoId = String(payload.fileId || "");
  if (
    state.driveTranscriptPayload &&
    videoId &&
    videoId === state.videoId &&
    String(payload.signature || "") === String(state.driveTranscriptPayload.signature || "") &&
    state.cues.length
  ) {
    return;
  }

  const rawCues = Array.isArray(payload.cues)
    ? payload.cues
      .slice(0, 10000)
      .map((cue) => ({
        startMs: Number(cue && cue.startMs),
        endMs: Number(cue && cue.endMs),
        sourceText: Core.normalizeSubtitleText(cue && cue.sourceText).slice(0, 2000)
      }))
      .filter((cue) => (
        Number.isFinite(cue.startMs) &&
        Number.isFinite(cue.endMs) &&
        cue.endMs > cue.startMs &&
        cue.sourceText
      ))
    : [];

  if (!videoId || !rawCues.length) {
    setStatus("Google Drive 没有可用的转写字幕。");
    return;
  }

  const sourceLang = String(state.settings.sourceLanguage || "en").toLowerCase();
  const trackFingerprint = Core.fingerprintText([
    "google-drive",
    videoId,
    sourceLang,
    String(payload.signature || ""),
    rawCues.length
  ].join("|"));

  state.driveTranscriptPayload = payload;
  state.lastPlayerResponse = null;

  if (
    videoId === state.videoId &&
    trackFingerprint === state.trackFingerprint &&
    state.cues.length
  ) {
    return;
  }

  resetVideoState(videoId, null, trackFingerprint, null);
  setStatus("正在读取 Google Drive 转写字幕...");
  const token = state.loadingToken;

  try {
    if (await restorePreparedCaptionCues(videoId, trackFingerprint, token)) {
      return;
    }
    await prepareCaptionCues(
      rawCues,
      videoId,
      trackFingerprint,
      token,
      "Google Drive 转写"
    );
  } catch (error) {
    if (token !== state.loadingToken) {
      return;
    }
    setStatus(`Google Drive 字幕读取失败：${simplifyTranslationError(error && error.message ? error.message : error)}`);
  }
}

async function handlePlayerResponse(payload) {
  if (!state.settings.subtitleEnabled) {
    setStatus("");
    return;
  }

  const videoId = String(payload.videoId || "");
  const urlVideoId = getUrlVideoId();
  if (urlVideoId && videoId && videoId !== urlVideoId) {
    requestPlayerResponse();
    return;
  }

  state.lastPlayerResponse = payload;
  const tracks = Array.isArray(payload.captionTracks) ? payload.captionTracks : [];
  const transcript = payload.transcript || null;
  const track = selectSourceTrack(tracks);

  if (!track && !hasTranscriptApi(transcript)) {
    resetVideoState(videoId, null, "");
    setStatus(`未找到源语言字幕轨道：这个视频可能没有 ${state.settings.sourceLanguage || "en"} 自动字幕。`);
    return;
  }

  const trackFingerprint = makeStableTrackFingerprint(videoId, track, transcript);
  const captionLoadKey = makeCaptionLoadKey(trackFingerprint, track, transcript);

  if (videoId === state.videoId && trackFingerprint === state.trackFingerprint) {
    if (state.cues.length || captionLoadKey === state.captionLoadKey) {
      if (state.captionLoadPromise) {
        await state.captionLoadPromise;
      }
      return;
    }
  }

  resetVideoState(videoId, track, trackFingerprint, transcript);
  state.captionLoadKey = captionLoadKey;
  const captionLoadPromise = loadCaptionTrack(videoId, track, trackFingerprint, transcript);
  state.captionLoadPromise = captionLoadPromise;
  try {
    await captionLoadPromise;
  } finally {
    if (state.captionLoadPromise === captionLoadPromise) {
      state.captionLoadPromise = null;
    }
  }
}


// --- Bootstrap ---
// Runs only after every other content-*.js file has been evaluated, because this
// file is loaded last.
if (!IS_DRIVE_PLAYER) {
  bindPageMessages();
  injectPageBridge();
}
init();
