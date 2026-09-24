// Shared webpage state, storage helpers, and page identity.
// Modules share only YTBTImmersive; startup runs last in immersive.js.
(function () {
  "use strict";
  const Core = globalThis.YTBTCore;
  if (!Core || !globalThis.chrome || !chrome.runtime || window.top !== window) return;
  if (globalThis.YTBTImmersive) return;
  const App = globalThis.YTBTImmersive = { Core };

  const BATCH_CHAR_LIMIT = 7000;
  const DEFAULT_BALL_TOP_PCT = 50;
  const state = {
    ball: null,
    ballText: null,
    panel: null,
    panelTimer: null,
    panelStatusText: "",
    panelStatusPersistent: false,
    // Progress stays hidden while translating: the panel only appears when the
    // pointer is on the floating control (or the open panel itself).
    pointerOverControl: false,
    mode: "idle",
    visible: true,
    translated: false,
    runToken: 0,
    pageUrl: pageIdentity(),
    recovery: null,
    recoveryTimer: null,
    recovering: false,
    preferences: { ...Core.DEFAULT_SETTINGS },
    runPreferences: null,
    preferencesReady: null,
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
  function pageIdentity() {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
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

  Object.assign(App, { BATCH_CHAR_LIMIT, DEFAULT_BALL_TOP_PCT, state, pageIdentity, storageGet, storageSet, clamp });
})();
