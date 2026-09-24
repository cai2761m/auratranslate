(function runPopup() {
  "use strict";

  const openSettings = document.querySelector("#open-settings");
  const openServiceSettings = document.querySelector("#open-service-settings");
  const openSettingsMore = document.querySelector("#open-settings-more");
  const moreToggle = document.querySelector("#more-toggle");
  const morePanel = document.querySelector("#more-panel");
  const sourceLanguage = document.querySelector("#source-language");
  const targetLanguage = document.querySelector("#target-language");
  const subtitleMode = document.querySelector("#subtitle-mode");
  const serviceName = document.querySelector("#service-name");
  const version = document.querySelector("#version");
  const subtitleEnabledToggle = document.querySelector("#subtitle-enabled-toggle");

  init();

  async function init() {
    if (subtitleEnabledToggle) {
      await hydrateSubtitleToggle();
      subtitleEnabledToggle.addEventListener("change", saveSubtitleToggle);
    }

    const settingsButtons = [openSettings, openServiceSettings, openSettingsMore].filter(Boolean);
    settingsButtons.forEach((button) => button.addEventListener("click", openOptionsPage));
    if (moreToggle && morePanel) {
      moreToggle.addEventListener("click", () => {
        const expanded = moreToggle.getAttribute("aria-expanded") === "true";
        moreToggle.setAttribute("aria-expanded", String(!expanded));
        morePanel.hidden = expanded;
      });
    }
    await hydrateQuickSettings();
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  async function hydrateSubtitleToggle() {
    const values = await storageGet(globalThis.YTBTCore.DEFAULT_SETTINGS);
    subtitleEnabledToggle.checked = values.subtitleEnabled !== false;
  }

  async function hydrateQuickSettings() {
    const Core = globalThis.YTBTCore;
    const values = await storageGet(Core.DEFAULT_SETTINGS);
    sourceLanguage.value = values.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    targetLanguage.value = values.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    subtitleMode.value = values.subtitleTranslationMode === "full" ? "full" : "economy";
    version.textContent = `v${chrome.runtime.getManifest().version}`;

    const immersive = Core.resolveTranslationConfig(values, "immersive");
    const ready = Boolean(immersive.apiKey && immersive.model &&
      (immersive.apiStyle === "gemini" ? immersive.generateContentUrl : immersive.chatCompletionsUrl));
    const fallback = values.immersiveFallbackProvider;
    const fallbackReady = fallback === "google-free" ||
      (fallback === "google-cloud" && Boolean(String(values.immersiveGoogleApiKey || "").trim()));
    serviceName.textContent = ready ? immersive.providerLabel : fallbackReady
      ? fallback === "google-free" ? "Google 翻译兜底" : "Google Cloud 兜底"
      : "尚未配置 API";
    serviceName.classList.toggle("service-missing", !ready && !fallbackReady);

    sourceLanguage.addEventListener("change", () => saveQuickSetting({ sourceLanguage: sourceLanguage.value }, sourceLanguage));
    targetLanguage.addEventListener("change", () => saveQuickSetting({ targetLanguage: targetLanguage.value }, targetLanguage));
    subtitleMode.addEventListener("change", () => saveQuickSetting({ subtitleTranslationMode: subtitleMode.value }, subtitleMode));
  }

  async function saveQuickSetting(values, control) {
    control.disabled = true;
    try {
      await storageSet(values);
    } finally {
      control.disabled = false;
    }
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
