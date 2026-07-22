(function runOptionsPage() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const form = document.querySelector("#settings-form");
  const settingsToggle = document.querySelector("#settings-toggle");
  const realtimeApi = createApiFields("");
  const immersiveApi = createApiFields("immersive");
  const llmSentenceSegmentationEnabled = document.querySelector("#llmSentenceSegmentationEnabled");
  const asrCorrectionEnabled = document.querySelector("#asrCorrectionEnabled");
  const sourceLanguage = document.querySelector("#sourceLanguage");
  const targetLanguage = document.querySelector("#targetLanguage");
  const fontScale = document.querySelector("#fontScale");
  const fontScaleValue = document.querySelector("#fontScaleValue");
  const subtitleEnabled = document.querySelector("#subtitleEnabled");
  const status = document.querySelector("#status");
  const clearCache = document.querySelector("#clear-cache");

  init();

  async function init() {
    if (!form) {
      return;
    }

    const settings = await storageGet(Core.DEFAULT_SETTINGS);
    hydrateApiFields(realtimeApi, settings, "realtime");
    hydrateApiFields(immersiveApi, settings, "immersive");

    if (llmSentenceSegmentationEnabled) {
      llmSentenceSegmentationEnabled.checked = settings.llmSentenceSegmentationEnabled !== false;
    }
    if (asrCorrectionEnabled) {
      asrCorrectionEnabled.checked = settings.asrCorrectionEnabled !== false;
    }
    if (sourceLanguage) {
      sourceLanguage.value = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    }
    if (targetLanguage) {
      targetLanguage.value = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    }
    if (fontScale) {
      fontScale.value = settings.fontScale || Core.DEFAULT_SETTINGS.fontScale;
    }
    if (subtitleEnabled) {
      subtitleEnabled.checked = settings.subtitleEnabled !== false;
    }

    updateFontScaleLabel();
    bindApiFieldEvents(realtimeApi);
    bindApiFieldEvents(immersiveApi);

    if (settingsToggle) {
      settingsToggle.addEventListener("click", toggleSettingsPanel);
    }
    if (fontScale) {
      fontScale.addEventListener("input", updateFontScaleLabel);
    }
    form.addEventListener("submit", saveSettings);
    if (clearCache) {
      clearCache.addEventListener("click", clearTranslationCache);
    }
  }

  function createApiFields(prefix) {
    const idPrefix = prefix ? `${prefix}Translation` : "translation";
    return {
      profile: prefix || "realtime",
      provider: document.querySelector(`#${idPrefix}Provider`),
      apiKey: document.querySelector(`#${idPrefix}ApiKey`),
      baseUrl: document.querySelector(`#${idPrefix}BaseUrl`),
      model: document.querySelector(`#${idPrefix}Model`),
      jsonResponse: document.querySelector(`#${idPrefix}JsonResponse`)
    };
  }

  function hydrateApiFields(fields, settings, profile) {
    if (!fields.provider) {
      return;
    }

    const isImmersive = profile === "immersive";
    const config = Core.resolveTranslationConfig(settings, isImmersive ? "immersive" : undefined);

    fields.provider.value = isImmersive
      ? settings.immersiveTranslationProvider || ""
      : config.provider;
    fields.apiKey.value = isImmersive
      ? settings.immersiveTranslationApiKey || ""
      : settings.translationApiKey || settings.deepseekApiKey || "";
    fields.baseUrl.value = isImmersive
      ? settings.immersiveTranslationBaseUrl || ""
      : settings.translationBaseUrl || config.baseUrl || "";
    fields.model.value = isImmersive
      ? settings.immersiveTranslationModel || ""
      : settings.translationModel || config.model || "";
    fields.jsonResponse.checked = isImmersive
      ? settings.immersiveTranslationJsonResponse !== false
      : settings.translationJsonResponse !== false;

    updateProviderPlaceholders(fields);
  }

  function bindApiFieldEvents(fields) {
    if (!fields.provider) {
      return;
    }

    fields.provider.addEventListener("change", () => handleProviderChange(fields));
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  async function saveSettings(event) {
    event.preventDefault();
    const realtime = readApiFields(realtimeApi);
    const immersive = readApiFields(immersiveApi);
    const useDedicatedImmersiveApi = Boolean(immersive.provider);

    await storageSet({
      translationProvider: realtime.provider || "deepseek",
      translationApiKey: realtime.apiKey,
      translationBaseUrl: realtime.baseUrl,
      translationModel: realtime.model,
      translationJsonResponse: realtime.jsonResponse,
      deepseekApiKey: realtime.provider === "deepseek" ? realtime.apiKey : "",
      immersiveTranslationProvider: immersive.provider,
      immersiveTranslationApiKey: useDedicatedImmersiveApi ? immersive.apiKey : "",
      immersiveTranslationBaseUrl: useDedicatedImmersiveApi ? immersive.baseUrl : "",
      immersiveTranslationModel: useDedicatedImmersiveApi ? immersive.model : "",
      immersiveTranslationJsonResponse: useDedicatedImmersiveApi ? immersive.jsonResponse : true,
      llmSentenceSegmentationEnabled: readChecked(llmSentenceSegmentationEnabled, true),
      asrCorrectionEnabled: readChecked(asrCorrectionEnabled, true),
      sourceLanguage: readValue(sourceLanguage, Core.DEFAULT_SETTINGS.sourceLanguage),
      targetLanguage: readValue(targetLanguage, Core.DEFAULT_SETTINGS.targetLanguage),
      fontScale: Number(readValue(fontScale, Core.DEFAULT_SETTINGS.fontScale)),
      subtitleEnabled: readChecked(subtitleEnabled, true)
    });
    showStatus("设置已保存。");
  }

  function readApiFields(fields) {
    if (!fields.provider) {
      return {
        provider: "deepseek",
        apiKey: "",
        baseUrl: "",
        model: "",
        jsonResponse: true
      };
    }

    return {
      provider: fields.provider.value,
      apiKey: fields.apiKey.value.trim(),
      baseUrl: fields.baseUrl.value.trim(),
      model: fields.model.value.trim(),
      jsonResponse: fields.jsonResponse.checked
    };
  }

  function readValue(element, fallback) {
    return element ? element.value : fallback;
  }

  function readChecked(element, fallback) {
    return element ? element.checked : fallback;
  }

  async function clearTranslationCache() {
    const all = await storageGet(null);
    const cacheKeys = Object.keys(all).filter((key) => key.startsWith("ytbt:"));
    if (cacheKeys.length) {
      await storageRemove(cacheKeys);
    }
    await storageSet({ cacheVersion: String(Date.now()) });
    showStatus(`已清空 ${cacheKeys.length} 组翻译缓存。`);
  }

  function updateFontScaleLabel() {
    if (fontScaleValue && fontScale) {
      fontScaleValue.textContent = `${Number(fontScale.value || 1).toFixed(1)}x`;
    }
  }

  function toggleSettingsPanel() {
    form.hidden = !form.hidden;
    settingsToggle.setAttribute("aria-expanded", String(!form.hidden));
    settingsToggle.textContent = form.hidden ? "设置" : "收起设置";
  }

  function handleProviderChange(fields) {
    if (fields.provider.value === "") {
      fields.apiKey.value = "";
      fields.baseUrl.value = "";
      fields.model.value = "";
    } else if (fields.provider.value === "deepseek") {
      fields.baseUrl.value = Core.DEEPSEEK_BASE_URL;
      fields.model.value = Core.DEEPSEEK_MODEL;
    } else if (fields.provider.value === "gemini") {
      fields.baseUrl.value = Core.GEMINI_BASE_URL;
      fields.model.value = Core.GEMINI_MODEL;
    } else if (fields.baseUrl.value.trim() === Core.DEEPSEEK_BASE_URL) {
      fields.baseUrl.value = "";
      fields.model.value = "";
    } else if (fields.baseUrl.value.trim() === Core.GEMINI_BASE_URL) {
      fields.baseUrl.value = "";
      fields.model.value = "";
    }
    updateProviderPlaceholders(fields);
  }

  function updateProviderPlaceholders(fields) {
    if (fields.provider.value === "") {
      fields.apiKey.placeholder = "沿用实时字幕 API Key";
      fields.baseUrl.placeholder = "沿用实时字幕 Base URL";
      fields.model.placeholder = "沿用实时字幕模型";
    } else if (fields.provider.value === "deepseek") {
      fields.apiKey.placeholder = "sk-...";
      fields.baseUrl.placeholder = Core.DEEPSEEK_BASE_URL;
      fields.model.placeholder = Core.DEEPSEEK_MODEL;
    } else if (fields.provider.value === "gemini") {
      fields.apiKey.placeholder = "AIza...";
      fields.baseUrl.placeholder = Core.GEMINI_BASE_URL;
      fields.model.placeholder = Core.GEMINI_MODEL;
    } else {
      fields.apiKey.placeholder = "sk-...";
      fields.baseUrl.placeholder = "https://api.example.com/v1";
      fields.model.placeholder = "model-name";
    }
  }

  function showStatus(message) {
    if (!status) {
      return;
    }

    status.textContent = message;
    setTimeout(() => {
      if (status.textContent === message) {
        status.textContent = "";
      }
    }, 2400);
  }
})();
