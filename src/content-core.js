/*
 * AuraTranslate content script — shared constants, state, and helpers
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

// --- Caption channels, timings, and batching constants ---
var Core = globalThis.YTBTCore;
var CHANNEL = "__ytbt_player_response__";
var DRIVE_CHANNEL = "__ytbt_drive_transcript__";
var IS_DRIVE_PLAYER =
  window.location.hostname === "youtube.googleapis.com" &&
  window.location.pathname.startsWith("/embed");
var BATCH_SIZE = 30;
var GEMINI_BATCH_SIZE = 8;
var CUSTOM_BATCH_SIZE = 15;
var RETRY_BATCH_SIZE = 5;
var GEMINI_RETRY_BATCH_SIZE = 3;
var CUSTOM_RETRY_BATCH_SIZE = 5;
var MAX_CUE_TRANSLATION_RETRIES = 2;
var MAX_PARALLEL_BATCHES = 2;
var GEMINI_MAX_PARALLEL_BATCHES = 1;
var CUSTOM_MAX_PARALLEL_BATCHES = 4;
var TRANSLATION_MESSAGE_TIMEOUT_MS = 130000;
var SEGMENTATION_MESSAGE_TIMEOUT_MS = 600000;
var PREPARED_CAPTION_CACHE_PREFIX = "ytbt:prepared:";
var MAX_PREPARED_CAPTION_CACHE_ENTRIES = 40;
var PRIORITY_WINDOW_MS = 120000;
var URGENT_RESCHEDULE_MS = 1000;
var RATE_LIMIT_BACKOFF_MS = 60000;
var SERVICE_BACKOFF_MS = 30000;
var DEFAULT_API_BACKOFF_MS = 10000;
var DRAG_EDGE_PADDING_PX = 12;
var DRIVE_OVERLAY_GEOMETRY_INTERVAL_MS = 250;
var DRIVE_OVERLAY_GEOMETRY_REFRESH_MS = 2000;
var TRANSCRIPT_PANEL_ID = "PAmodern_transcript_view";
var TRANSCRIPT_PANEL_TIMEOUT_MS = 8000;
var TRANSCRIPT_PANEL_MAX_BODY_LENGTH = 20000000;
var TRANSCRIPT_CLIENT_VERSION_FALLBACK = "2.20260729.00.00";
var NATIVE_CAPTION_CAPTURE_TIMEOUT_MS = 7000;
var NATIVE_CAPTION_SELECTOR = [
  ".ytp-caption-window-container",
  ".ytp-caption-window-rollup",
  ".ytp-caption-window-bottom",
  ".ytp-caption-window-top",
  ".caption-window",
  ".captions-text",
  ".caption-visual-line",
  ".ytp-caption-segment"
].join(",");

var state = {
  settings: Object.assign({}, Core.DEFAULT_SETTINGS),
  lastPlayerResponse: null,
  driveTranscriptPayload: null,
  videoId: "",
  track: null,
  transcript: null,
  trackFingerprint: "",
  translationTrackFingerprint: "",
  cues: [],
  preparationPromise: null,
  preparationBlocked: false,
  queue: [],
  inFlight: new Map(),
  batchSerial: 0,
  loadingToken: 0,
  statusText: "",
  overlay: null,
  overlayParts: null,
  lastDriveOverlayGeometryAt: 0,
  lastDriveOverlayGeometrySignature: "",
  overlayDrag: {
    pointerId: null,
    touchId: null,
    captureTarget: null,
    active: false,
    offsetX: 0,
    offsetY: 0,
    lastClientX: 0,
    lastClientY: 0
  },
  video: null,
  nativeCaptionObserver: null,
  lastNativeCaptionSweepAt: 0,
  lastUrgentScheduleAt: 0,
  apiBackoffUntil: 0,
  apiBackoffMessage: "",
  apiBackoffTimer: null,
  bridgeInjected: false,
  settingsLoaded: false,
  pendingPlayerResponse: null,
  captionLoadKey: "",
  captionLoadPromise: null,
  nativeCaptionWaiters: new Set(),
  pumping: false
};


// --- chrome.storage promise wrappers ---
function storageGet(defaults) {
  return new Promise((resolve, reject) => chrome.storage.local.get(defaults, (values) => {
    const error = chrome.runtime && chrome.runtime.lastError;
    if (error) reject(new Error(`读取本地字幕缓存失败：${error.message}`));
    else resolve(values);
  }));
}

function storageSet(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime && chrome.runtime.lastError;
    if (error) reject(new Error(`保存本地字幕缓存失败：${error.message}`));
    else resolve();
  }));
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.remove(keys, () => {
    const error = chrome.runtime && chrome.runtime.lastError;
    if (error) reject(new Error(`整理本地字幕缓存失败：${error.message}`));
    else resolve();
  }));
}


// --- Shared status and error text helpers ---
function formatCueFailureText(message) {
  const detail = simplifyTranslationError(message);
  return detail ? `翻译失败：${detail}` : "翻译失败";
}

function simplifyTranslationError(message) {
  const text = Core.normalizeSubtitleText(message || "");
  if (!text) {
    return "";
  }

  return text
    .replace(/^Error:\s*/i, "")
    .replace(/^Gemini request failed \((\d+)\):\s*/i, "Gemini $1：")
    .replace(/^DeepSeek request failed \((\d+)\):\s*/i, "DeepSeek $1：")
    .replace(/^Custom API request failed \((\d+)\):\s*/i, "API $1：")
    .slice(0, 90);
}

function missingApiConfigText() {
  const config = Core.resolveTranslationConfig(state.settings);
  return `请在扩展选项页填写 ${config.providerLabel} API 配置`;
}

function setStatus(text) {
  state.statusText = text || "";
}
