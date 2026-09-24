// Webpage translation startup and lifecycle listeners.
// Modules share only YTBTImmersive; startup runs last in immersive.js.
(function () {
  "use strict";
  const App = globalThis.YTBTImmersive;
  if (!App) return;
  const { Core, state } = App;

  function init() {
    const root = document.documentElement;
    if (!root || root.dataset.ytbtImmersiveReady === "true") {
      return;
    }
    root.dataset.ytbtImmersiveReady = "true";
    state.preferencesReady = App.loadPreferences();
    chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
      if (message.type === "IMMERSIVE_POPUP_TRANSLATE") {
        if (state.mode !== "translating") App.translateCurrentPage();
      } else if (message.type !== "IMMERSIVE_POPUP_STATUS") return;
      sendResponse({ ok: true, mode: state.mode, translated: state.translated, status: state.panelStatusText });
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      for (const key of Object.keys(Core.DEFAULT_SETTINGS)) {
        if (changes[key]) state.preferences[key] = changes[key].newValue ?? Core.DEFAULT_SETTINGS[key];
      }
      if (changes.immersiveDisplayMode) App.applyDisplayMode();
      if (changes.immersiveAutoTranslate || changes.immersiveSiteRules) App.maybeAutoTranslate();
    });
    document.addEventListener("visibilitychange", () => {
      App.syncPageIdentity();
      if (!document.hidden) App.recoverCachedTranslations();
    });
    window.addEventListener("pageshow", () => {
      App.syncPageIdentity();
      App.recoverCachedTranslations();
    });
    window.addEventListener("popstate", App.syncPageIdentity);
    // SPA navigation need not dispatch popstate. Never attribute old text to
    // a new URL or let an old response change the new page's controls.
    setInterval(App.syncPageIdentity, 1000);

    if (document.body) {
      App.mountControls();
    } else {
      document.addEventListener("DOMContentLoaded", App.mountControls, { once: true });
    }
  }


  init();
})();
