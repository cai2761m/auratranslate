(function runOptionsPage() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const form = document.querySelector("#settings-form");
  const settingsToggle = document.querySelector("#settings-toggle");
  const realtimeApi = createApiFields("");
  const immersiveApi = createApiFields("immersive");
  const immersiveFallbackProvider = document.querySelector("#immersiveFallbackProvider");
  const immersiveGoogleApiKey = document.querySelector("#immersiveGoogleApiKey");
  const llmSentenceSegmentationEnabled = document.querySelector("#llmSentenceSegmentationEnabled");
  const asrCorrectionEnabled = document.querySelector("#asrCorrectionEnabled");
  const showOriginalTechnicalTerms = document.querySelector("#showOriginalTechnicalTerms");
  const sourceLanguage = document.querySelector("#sourceLanguage");
  const targetLanguage = document.querySelector("#targetLanguage");
  const fontScale = document.querySelector("#fontScale");
  const fontScaleValue = document.querySelector("#fontScaleValue");
  const subtitleEnabled = document.querySelector("#subtitleEnabled");
  const subtitleTranslationMode = document.querySelector("#subtitleTranslationMode");
  const subtitleLookAheadMinutes = document.querySelector("#subtitleLookAheadMinutes");
  const status = document.querySelector("#status");
  const clearCache = document.querySelector("#clear-cache");

  // Each entry owns one sub-page; the hash keeps the current page shareable and reloadable.
  const SUB_PAGES = [
    { id: "realtime-api", label: "实时字幕" },
    { id: "immersive-api", label: "沉浸式翻译" },
    { id: "general-settings", label: "通用设置" }
  ];
  const DEFAULT_SUB_PAGE = SUB_PAGES[0].id;

  init();

  async function init() {
    if (!form) {
      return;
    }

    setupSubPageNavigation();

    const settings = await storageGet(Core.DEFAULT_SETTINGS);
    hydrateApiFields(realtimeApi, settings, "realtime");
    hydrateApiFields(immersiveApi, settings, "immersive");
    if (immersiveFallbackProvider && immersiveGoogleApiKey) {
      immersiveFallbackProvider.value = settings.immersiveFallbackProvider || "off";
      immersiveGoogleApiKey.value = settings.immersiveGoogleApiKey || "";
      const updateFallbackFields = () => {
        immersiveGoogleApiKey.closest("label").hidden = immersiveFallbackProvider.value !== "google-cloud";
      };
      updateFallbackFields();
      immersiveFallbackProvider.addEventListener("change", updateFallbackFields);
    }

    if (llmSentenceSegmentationEnabled) {
      llmSentenceSegmentationEnabled.checked = settings.llmSentenceSegmentationEnabled !== false;
    }
    if (asrCorrectionEnabled) {
      asrCorrectionEnabled.checked = settings.asrCorrectionEnabled !== false;
    }
    if (showOriginalTechnicalTerms) {
      showOriginalTechnicalTerms.checked = settings.showOriginalTechnicalTerms !== false;
    }
    if (sourceLanguage) {
      sourceLanguage.value = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    }
    if (targetLanguage) {
      targetLanguage.value = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    }
    if (fontScale) {
      fontScale.min = String(Core.FONT_SCALE_MIN);
      fontScale.max = String(Core.FONT_SCALE_MAX);
      fontScale.step = String(Core.FONT_SCALE_STEP);
      fontScale.value = Core.normalizeFontScale(settings.fontScale);
    }
    if (subtitleEnabled) {
      subtitleEnabled.checked = settings.subtitleEnabled !== false;
    }
    if (subtitleTranslationMode) subtitleTranslationMode.value = settings.subtitleTranslationMode === "full" ? "full" : "economy";
    if (subtitleLookAheadMinutes) subtitleLookAheadMinutes.value = String(settings.subtitleLookAheadMinutes || 2);

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

  function setupSubPageNavigation() {
    const pages = [];
    for (const subPage of SUB_PAGES) {
      const tab = document.querySelector(`#tab-${subPage.id}`);
      const panel = document.querySelector(`#${subPage.id}`);
      if (tab && panel) {
        pages.push({ id: subPage.id, label: subPage.label, tab, panel });
      }
    }
    if (!pages.length) {
      return;
    }

    const activate = (id, options = {}) => {
      const target = pages.find((page) => page.id === id) || pages[0];
      for (const page of pages) {
        const selected = page === target;
        // Hidden sub-pages keep their values, so one save button still stores every page.
        page.panel.hidden = !selected;
        page.tab.setAttribute("aria-selected", String(selected));
        page.tab.setAttribute("tabindex", selected ? "0" : "-1");
      }
      if (options.title !== false) {
        document.title = `${target.label} · AuraTranslate 设置`;
      }
      if (options.updateUrl) {
        writeSubPageHash(target.id);
      }
      if (options.focusTab) {
        target.tab.focus();
      }
      if (options.scroll) {
        scrollToLayoutTop();
      }
    };

    const moveFocus = (index) => {
      const next = pages[(index + pages.length) % pages.length];
      activate(next.id, { updateUrl: true, scroll: true, focusTab: true });
    };

    pages.forEach((page, index) => {
      page.tab.addEventListener("click", () => {
        activate(page.id, { updateUrl: true, scroll: true });
      });
      page.tab.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          moveFocus(index + 1);
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          moveFocus(index - 1);
        } else if (event.key === "Home") {
          moveFocus(0);
        } else if (event.key === "End") {
          moveFocus(pages.length - 1);
        } else {
          return;
        }
        event.preventDefault();
      });
    });

    if (typeof window !== "undefined" && window.addEventListener) {
      const followHistory = () => activate(currentSubPageId(), { updateUrl: false });
      window.addEventListener("hashchange", followHistory);
      window.addEventListener("popstate", followHistory);
    }

    activate(currentSubPageId(), { updateUrl: false });
  }

  function currentSubPageId() {
    if (typeof window === "undefined" || !window.location) {
      return DEFAULT_SUB_PAGE;
    }
    const id = String(window.location.hash || "").replace(/^#\/?/, "");
    return SUB_PAGES.some((page) => page.id === id) ? id : DEFAULT_SUB_PAGE;
  }

  function writeSubPageHash(id) {
    if (typeof window === "undefined" || !window.history || !window.location) {
      return;
    }
    if (String(window.location.hash || "").replace(/^#/, "") === id) {
      return;
    }
    try {
      window.history.pushState(null, "", `#${id}`);
    } catch (error) {
      // Sandboxed documents cannot rewrite the URL; the sub-page switch still applies.
    }
  }

  function scrollToLayoutTop() {
    if (typeof window === "undefined" || typeof window.scrollTo !== "function") {
      return;
    }
    const layout = document.querySelector(".settings-layout");
    const top = layout && typeof layout.getBoundingClientRect === "function"
      ? Math.max(layout.getBoundingClientRect().top + (window.scrollY || 0) - 20, 0)
      : 0;
    window.scrollTo({ top, behavior: "smooth" });
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

    const inheritsRealtime = isImmersive && !settings.immersiveTranslationProvider;
    fields.provider.value = inheritsRealtime ? "" : "custom";
    fields.apiKey.value = isImmersive
      ? settings.immersiveTranslationApiKey || ""
      : settings.translationApiKey || settings.deepseekApiKey || "";
    fields.baseUrl.value = inheritsRealtime ? "" : compatibleBaseUrl(config);
    fields.model.value = inheritsRealtime ? "" : config.model;
    fields.jsonResponse.checked = isImmersive
      ? settings.immersiveTranslationJsonResponse !== false
      : settings.translationJsonResponse !== false;

    updateProviderPlaceholders(fields);
  }

  function compatibleBaseUrl(config) {
    if (config.provider !== "gemini") return config.baseUrl;
    // Preserve legacy Gemini credentials while switching the settings form to
    // Google's OpenAI-compatible endpoint instead of its native protocol.
    const baseUrl = config.baseUrl.replace(/\/+$/, "").replace(/\/(?:models|tunedModels)\/[^/]+:generateContent$/i, "");
    return /\/openai$/i.test(baseUrl) ? baseUrl : `${baseUrl}/openai`;
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
      translationProvider: "custom",
      translationApiKey: realtime.apiKey,
      translationBaseUrl: realtime.baseUrl,
      translationModel: realtime.model,
      translationJsonResponse: realtime.jsonResponse,
      immersiveTranslationProvider: immersive.provider,
      immersiveTranslationApiKey: useDedicatedImmersiveApi ? immersive.apiKey : "",
      immersiveTranslationBaseUrl: useDedicatedImmersiveApi ? immersive.baseUrl : "",
      immersiveTranslationModel: useDedicatedImmersiveApi ? immersive.model : "",
      immersiveTranslationJsonResponse: useDedicatedImmersiveApi ? immersive.jsonResponse : true,
      immersiveFallbackProvider: readValue(immersiveFallbackProvider, "off"),
      immersiveGoogleApiKey: readValue(immersiveGoogleApiKey, "").trim(),
      llmSentenceSegmentationEnabled: readChecked(llmSentenceSegmentationEnabled, true),
      asrCorrectionEnabled: readChecked(asrCorrectionEnabled, true),
      showOriginalTechnicalTerms: readChecked(showOriginalTechnicalTerms, true),
      sourceLanguage: readValue(sourceLanguage, Core.DEFAULT_SETTINGS.sourceLanguage),
      targetLanguage: readValue(targetLanguage, Core.DEFAULT_SETTINGS.targetLanguage),
      fontScale: Core.normalizeFontScale(readValue(fontScale, Core.DEFAULT_SETTINGS.fontScale)),
      subtitleEnabled: readChecked(subtitleEnabled, true),
      subtitleTranslationMode: readValue(subtitleTranslationMode, "economy") === "full" ? "full" : "economy",
      subtitleLookAheadMinutes: Number(readValue(subtitleLookAheadMinutes, "2"))
    });
    await storageRemove("deepseekApiKey");
    showStatus("设置已保存。");
  }

  function readApiFields(fields) {
    if (!fields.provider) {
      return {
        provider: "custom",
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
      fontScaleValue.textContent = `${Core.normalizeFontScale(fontScale.value).toFixed(2)}x`;
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
    }
    updateProviderPlaceholders(fields);
  }

  function updateProviderPlaceholders(fields) {
    if (fields.provider.value === "") {
      fields.apiKey.placeholder = "沿用实时字幕 API Key";
      fields.baseUrl.placeholder = "沿用实时字幕 Base URL";
      fields.model.placeholder = "沿用实时字幕模型";
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
