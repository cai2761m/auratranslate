// Default settings, language labels, API configuration, and cache keys.
// Browser: register before shared.js. Node: shared.js calls this factory.
(function registerSharedModule(root, register) {
  if (typeof module !== "undefined" && module.exports) module.exports = register;
  else register(root.YTBTShared || (root.YTBTShared = {}));
})(globalThis, function (Shared) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    translationProvider: "deepseek",
    translationApiKey: "",
    translationBaseUrl: "",
    translationModel: "",
    translationJsonResponse: true,
    immersiveTranslationProvider: "",
    immersiveTranslationApiKey: "",
    immersiveTranslationBaseUrl: "",
    immersiveTranslationModel: "",
    immersiveTranslationJsonResponse: true,
    immersiveFallbackProvider: "off",
    immersiveGoogleApiKey: "",
    immersiveSourceLanguage: "auto",
    immersiveTargetLanguage: "",
    immersiveTranslationService: "ai",
    immersiveDisplayMode: "bilingual",
    immersiveAutoTranslate: false,
    immersiveSiteRules: {},
    targetLanguage: "zh-CN",
    sourceLanguage: "en",
    fontScale: 1,
    subtitleEnabled: true,
    subtitleTranslationMode: "economy",
    subtitleLookAheadMinutes: 2,
    subtitlePosition: null,
    llmSentenceSegmentationEnabled: true,
    asrCorrectionEnabled: true,
    showOriginalTechnicalTerms: true,
    cacheVersion: "1",
    translationCacheMaxItems: 2000
  });

  // Legacy provider defaults remain available to resolve settings saved by
  // older versions; the current settings UI exposes a generic compatible API.
  const DEEPSEEK_MODEL = "deepseek-v4-flash";
  const FONT_SCALE_MIN = 0.3;
  const FONT_SCALE_MAX = 3;
  const FONT_SCALE_STEP = 0.05;

  function normalizeFontScale(value) {
    if (value == null || value === "" || typeof value === "boolean") return DEFAULT_SETTINGS.fontScale;
    const scale = Number(value);
    return Number.isFinite(scale)
      ? Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
      : DEFAULT_SETTINGS.fontScale;
  }

  const GEMINI_MODEL = "gemini-3.5-flash";
  const MERGE_VERSION = "5";
  const SENTENCE_SEGMENTATION_VERSION = "1";
  const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

  // Upper bound on the number of cached cue translations. Each `ytbt:` storage
  // key holds an entire video; once this many cached cues accumulate, the
  // least-recently-updated video keys are evicted to stay under the quota.
  const DEFAULT_CACHE_MAX_ITEMS = 2000;

  // Human-readable labels for the languages the prompt references. Unknown
  // codes fall back to a safe default so the prompt always reads sensibly.
  const LANGUAGE_LABELS = {
    "auto": "automatically detected source-language",
    "ja": "Japanese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "en": "English",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese"
  };

  function languageLabel(code, fallback) {
    const key = String(code || "").trim();
    if (LANGUAGE_LABELS[key]) {
      return LANGUAGE_LABELS[key];
    }
    // Handle regional variants like "en-US" by matching the base code.
    const base = key.split("-")[0];
    return LANGUAGE_LABELS[base] || fallback || "English";
  }

  function sourceLanguageLabel(code) {
    return languageLabel(code, "English");
  }

  function targetLanguageLabel(code) {
    return languageLabel(code, "Simplified Chinese");
  }

  function buildTechnicalTerminologyInstruction(showOriginalTechnicalTerms) {
    return showOriginalTechnicalTerms !== false
      ? "For any professional, technical, or specialized terms, you must append the original source term in parentheses immediately after its translation (e.g., '翻译 (Translation)'). "
      : "Translate professional, technical, and specialized terms naturally, but do not append or repeat source-language terms in parentheses unless those parentheses already appear in the source. ";
  }

  function fingerprintText(value) {
    const input = String(value || "");
    let hash = 5381;
    for (let index = 0; index < input.length; index += 1) {
      hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
      hash >>>= 0;
    }
    return hash.toString(36);
  }

  function makeCacheKey(parts) {
    const safeParts = Array.isArray(parts) ? parts : [];
    return `ytbt:${fingerprintText(safeParts.join("|"))}`;
  }

  function buildChatCompletionsUrl(baseUrl) {
    const raw = String(baseUrl || "").trim();
    if (!raw) {
      return "";
    }

    const trimmed = raw.replace(/\/+$/, "");
    return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
  }

  function buildGeminiGenerateContentUrl(baseUrl, model) {
    const rawBaseUrl = String(baseUrl || "").trim();
    const rawModel = String(model || "").trim().replace(/^\/+/, "");
    if (!rawBaseUrl || !rawModel) {
      return "";
    }

    const trimmedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
    if (/:generateContent$/i.test(trimmedBaseUrl)) {
      return trimmedBaseUrl;
    }

    const modelPath = /^(models|tunedModels)\//.test(rawModel) ? rawModel : `models/${rawModel}`;
    const encodedModelPath = modelPath.split("/").map(encodeURIComponent).join("/");
    return `${trimmedBaseUrl}/${encodedModelPath}:generateContent`;
  }

  function resolveTranslationConfig(settings, profile) {
    const source = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const useImmersiveConfig =
      profile === "immersive" && Boolean(String(source.immersiveTranslationProvider || "").trim());
    const providerValue = useImmersiveConfig
      ? source.immersiveTranslationProvider
      : source.translationProvider;
    const provider =
      providerValue === "custom" || providerValue === "gemini"
        ? providerValue
        : "deepseek";
    const apiKey = String(
      useImmersiveConfig
        ? source.immersiveTranslationApiKey
        : source.translationApiKey || source.deepseekApiKey || ""
    ).trim();
    const rawBaseUrl = String(
      useImmersiveConfig ? source.immersiveTranslationBaseUrl : source.translationBaseUrl
    ).trim();
    const rawModel = String(
      useImmersiveConfig ? source.immersiveTranslationModel : source.translationModel
    ).trim();
    let baseUrl =
      rawBaseUrl ||
      (provider === "deepseek" ? DEEPSEEK_BASE_URL : provider === "gemini" ? GEMINI_BASE_URL : "");
    let model =
      rawModel ||
      (provider === "deepseek" ? DEEPSEEK_MODEL : provider === "gemini" ? GEMINI_MODEL : "");

    if (provider === "gemini") {
      if (baseUrl === DEEPSEEK_BASE_URL || /\/chat\/completions$/i.test(baseUrl)) {
        baseUrl = GEMINI_BASE_URL;
      }
      if (model === DEEPSEEK_MODEL) {
        model = GEMINI_MODEL;
      }
    } else if (provider === "deepseek") {
      if (baseUrl === GEMINI_BASE_URL || /:generateContent$/i.test(baseUrl)) {
        baseUrl = DEEPSEEK_BASE_URL;
      }
      if (model === GEMINI_MODEL) {
        model = DEEPSEEK_MODEL;
      }
    }

    const apiStyle = provider === "gemini" ? "gemini" : "chat-completions";

    return {
      provider,
      providerLabel: provider === "deepseek" ? "DeepSeek" : provider === "gemini" ? "Gemini" : "Custom API",
      apiStyle,
      apiKey,
      baseUrl,
      chatCompletionsUrl: apiStyle === "chat-completions" ? buildChatCompletionsUrl(baseUrl) : "",
      generateContentUrl: apiStyle === "gemini" ? buildGeminiGenerateContentUrl(baseUrl, model) : "",
      model,
      useJsonResponseFormat: useImmersiveConfig
        ? source.immersiveTranslationJsonResponse !== false
        : source.translationJsonResponse !== false,
      includeDeepSeekThinkingFlag: provider === "deepseek"
    };
  }

  Object.assign(Shared, {
    DEFAULT_SETTINGS,
    DEEPSEEK_MODEL,
    FONT_SCALE_MIN,
    FONT_SCALE_MAX,
    FONT_SCALE_STEP,
    normalizeFontScale,
    GEMINI_MODEL,
    MERGE_VERSION,
    SENTENCE_SEGMENTATION_VERSION,
    DEEPSEEK_BASE_URL,
    GEMINI_BASE_URL,
    DEFAULT_CACHE_MAX_ITEMS,
    sourceLanguageLabel,
    targetLanguageLabel,
    buildTechnicalTerminologyInstruction,
    fingerprintText,
    makeCacheKey,
    buildChatCompletionsUrl,
    buildGeminiGenerateContentUrl,
    resolveTranslationConfig
  });
});
