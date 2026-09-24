(function runPopup() {
  "use strict";

  const openSettings = document.querySelector("#open-settings");
  const subtitleEnabledToggle = document.querySelector("#subtitle-enabled-toggle");

  init();

  async function init() {
    if (subtitleEnabledToggle) {
      await hydrateSubtitleToggle();
      subtitleEnabledToggle.addEventListener("change", saveSubtitleToggle);
    }

    if (openSettings) {
      openSettings.addEventListener("click", openOptionsPage);
    }
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  async function hydrateSubtitleToggle() {
    const values = await storageGet({ subtitleEnabled: true });
    subtitleEnabledToggle.checked = values.subtitleEnabled !== false;
  }

  async function saveSubtitleToggle() {
    subtitleEnabledToggle.disabled = true;
    try {
      await storageSet({ subtitleEnabled: subtitleEnabledToggle.checked });
    } finally {
      subtitleEnabledToggle.disabled = false;
    }
  }

  function openOptionsPage() {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage(() => window.close());
      return;
    }

    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") }, () => {
      window.close();
    });
  }
})();
