// Default settings, language labels, API configuration, and cache keys.
// Browser: register before shared.js. Node: shared.js calls this factory.
(function registerSharedModule(root, register) {
  if (typeof module !== "undefined" && module.exports) module.exports = register;
  else register(root.YTBTShared || (root.YTBTShared = {}));
})(globalThis, function (Shared) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    // User-managed provider list. Each entry owns its own credential, endpoint,
    // protocol and model catalog; the subtitle and immersive pages only pick
    // one entry plus one model from it.
    translationServices: [],
    translationServiceId: "",
    translationModelId: "",
    immersiveTranslationServiceId: "",
    immersiveTranslationModelId: "",
    // Legacy single-provider keys. They stay readable (and are mirrored on save)
    // so settings written by older versions keep working untouched.
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

  // Every service entry speaks the OpenAI-compatible protocol today; the map
  // exists so the settings UI can label the value and new protocols can be
  // added without touching the option pages.
  const TRANSLATION_SERVICE_PROTOCOLS = Object.freeze({
    "openai-compatible": "OpenAI-compatible API"
  });
  const DEFAULT_SERVICE_PROTOCOL = "openai-compatible";

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

  // Rewrites a legacy Gemini endpoint to its OpenAI-compatible sibling. The
  // settings form has been compatible-only since the provider list existed.
  function openAiCompatibleBaseUrl(baseUrl, provider) {
    const raw = String(baseUrl || "").trim();
    if (provider !== "gemini") return raw;
    const withoutEndpoint = raw.replace(/\/+$/, "").replace(/\/(?:models|tunedModels)\/[^/]+:generateContent$/i, "");
    const base = withoutEndpoint || GEMINI_BASE_URL;
    return /\/openai$/i.test(base) ? base : `${base}/openai`;
  }

  function hostLabel(baseUrl) {
    const raw = String(baseUrl || "").trim();
    if (!raw) return "";
    try {
      return new URL(raw).host || raw;
    } catch (error) {
      return raw.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
    }
  }

  function normalizeServiceModels(models) {
    const normalized = [];
    const seen = new Set();
    for (const entry of Array.isArray(models) ? models : []) {
      const id = String((entry && entry.id) || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push({ id, displayName: String((entry && entry.displayName) || "").trim() });
    }
    return normalized;
  }

  function normalizeTranslationService(service, index) {
    const source = service && typeof service === "object" ? service : {};
    return {
      id: String(source.id || "").trim() || `service-${index + 1}`,
      name: String(source.name || "").trim(),
      apiProtocol: TRANSLATION_SERVICE_PROTOCOLS[source.apiProtocol]
        ? source.apiProtocol
        : DEFAULT_SERVICE_PROTOCOL,
      baseUrl: String(source.baseUrl || "").trim(),
      apiKey: String(source.apiKey || "").trim(),
      models: normalizeServiceModels(source.models)
    };
  }

  function normalizeTranslationServices(services) {
    const list = Array.isArray(services) ? services : [];
    const normalized = [];
    const seen = new Set();
    for (let index = 0; index < list.length; index += 1) {
      const service = normalizeTranslationService(list[index], index);
      if (seen.has(service.id)) {
        service.id = `${service.id}-${index + 1}`;
      }
      seen.add(service.id);
      normalized.push(service);
    }
    return normalized;
  }

  // The row description shown on the 翻译服务 page. Incomplete entries read as
  // "待完善" so it is obvious which service still needs an endpoint or a model.
  function describeTranslationService(service) {
    const normalized = normalizeTranslationService(service, 0);
    const host = hostLabel(normalized.baseUrl);
    if (!host) return "待完善";
    const protocol = TRANSLATION_SERVICE_PROTOCOLS[normalized.apiProtocol] || normalized.apiProtocol;
    const modelCount = normalized.models.length;
    return `${host} · ${protocol} · ${modelCount ? `${modelCount} 个模型` : "尚未添加模型"}`;
  }

  function buildModelsUrl(baseUrl) {
    const raw = String(baseUrl || "").trim();
    if (!raw) return "";
    return `${raw.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "")}/models`;
  }

  function findServiceById(services, id) {
    const wanted = String(id || "").trim();
    if (!wanted) return null;
    return services.find((service) => service.id === wanted) || null;
  }

  function pickModelId(service, requestedModelId) {
    const models = service && Array.isArray(service.models) ? service.models : [];
    if (!models.length) return "";
    const wanted = String(requestedModelId || "").trim();
    return models.some((model) => model.id === wanted) ? wanted : models[0].id;
  }

  function legacyServiceFields(source, profile) {
    const immersive = profile === "immersive";
    const provider = String(immersive ? source.immersiveTranslationProvider : source.translationProvider || "").trim();
    const apiKey = String(
      immersive ? source.immersiveTranslationApiKey : source.translationApiKey || source.deepseekApiKey || ""
    ).trim();
    const baseUrl = String(immersive ? source.immersiveTranslationBaseUrl : source.translationBaseUrl || "").trim();
    const model = String(immersive ? source.immersiveTranslationModel : source.translationModel || "").trim();
    const providerName = provider === "gemini" ? "Gemini" : provider === "deepseek" ? "DeepSeek" : "";
    return {
      provider,
      apiKey,
      model,
      // Legacy installs relied on the provider defaults for the endpoint and
      // the model, so a migrated service keeps translating without edits.
      defaultModel: providerName === "Gemini" ? GEMINI_MODEL : providerName === "DeepSeek" ? DEEPSEEK_MODEL : "",
      baseUrl: openAiCompatibleBaseUrl(
        baseUrl || (providerName === "Gemini" ? GEMINI_BASE_URL : providerName === "DeepSeek" ? DEEPSEEK_BASE_URL : ""),
        provider
      )
    };
  }

  function serviceFromLegacyFields(fields, id) {
    const model = fields.model || fields.defaultModel;
    return {
      id,
      name: fields.provider === "gemini" ? "Gemini" : fields.provider === "deepseek" ? "DeepSeek" : hostLabel(fields.baseUrl) || "自定义服务",
      apiProtocol: DEFAULT_SERVICE_PROTOCOL,
      baseUrl: fields.baseUrl,
      apiKey: fields.apiKey,
      models: model ? [{ id: model, displayName: "" }] : []
    };
  }

  // Turns settings written before the provider list existed into editable
  // service entries. Returns null when there is nothing worth migrating.
  function migrateLegacyTranslationServices(settings) {
    const source = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const realtime = legacyServiceFields(source, "realtime");
    const immersive = legacyServiceFields(source, "immersive");
    const hasRealtime = Boolean(
      realtime.apiKey || String(source.translationBaseUrl || "").trim() || String(source.translationModel || "").trim()
    );
    const hasImmersive = Boolean(String(source.immersiveTranslationProvider || "").trim());
    if (!hasRealtime && !hasImmersive) return null;

    const services = [];
    let translationServiceId = "";
    let translationModelId = "";
    let immersiveTranslationServiceId = "";
    let immersiveTranslationModelId = "";

    if (hasRealtime) {
      const service = serviceFromLegacyFields(realtime, "legacy-realtime");
      services.push(service);
      translationServiceId = service.id;
      translationModelId = pickModelId(service, "");
    }

    if (hasImmersive) {
      const shared = services.find(
        (service) =>
          service.baseUrl === immersive.baseUrl &&
          service.apiKey === immersive.apiKey &&
          pickModelId(service, "") === (immersive.model || immersive.defaultModel)
      );
      if (shared) {
        immersiveTranslationServiceId = shared.id;
        immersiveTranslationModelId = pickModelId(shared, "");
      } else {
        const service = serviceFromLegacyFields(immersive, "legacy-immersive");
        services.push(service);
        immersiveTranslationServiceId = service.id;
        immersiveTranslationModelId = pickModelId(service, "");
      }
    }

    return {
      services,
      migrated: true,
      translationServiceId,
      translationModelId,
      immersiveTranslationServiceId,
      immersiveTranslationModelId
    };
  }

  // Single source of truth for "which services exist and which one is picked".
  // Stored services win; settings written before the provider list fall back to
  // the legacy keys (migrated on the fly so the option pages can edit them).
  function planTranslationServices(settings) {
    const source = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const services = normalizeTranslationServices(source.translationServices);
    if (!services.length) {
      const migrated = migrateLegacyTranslationServices(source);
      if (migrated) return migrated;
      return {
        services: [],
        migrated: false,
        translationServiceId: "",
        translationModelId: "",
        immersiveTranslationServiceId: "",
        immersiveTranslationModelId: ""
      };
    }

    const translationServiceId =
      findServiceById(services, source.translationServiceId) ? String(source.translationServiceId).trim() : services[0].id;
    const immersiveTranslationServiceId = findServiceById(services, source.immersiveTranslationServiceId)
      ? String(source.immersiveTranslationServiceId).trim()
      : "";
    return {
      services,
      migrated: false,
      translationServiceId,
      translationModelId: pickModelId(findServiceById(services, translationServiceId), source.translationModelId),
      immersiveTranslationServiceId,
      immersiveTranslationModelId: pickModelId(
        findServiceById(services, immersiveTranslationServiceId),
        source.immersiveTranslationModelId
      )
    };
  }

  function resolveTranslationConfig(settings, profile) {
    const source = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const immersiveRequested = profile === "immersive";
    const services = normalizeTranslationServices(source.translationServices);

    // Provider list mode: the sub-pages only choose a service and a model.
    if (services.length) {
      const requestedImmersiveId = String(source.immersiveTranslationServiceId || "").trim();
      let useDedicated = immersiveRequested && Boolean(requestedImmersiveId);
      let service = findServiceById(services, useDedicated ? requestedImmersiveId : source.translationServiceId);
      if (!service) {
        // A deleted dedicated service falls back to inheriting the realtime one.
        useDedicated = false;
        service = findServiceById(services, source.translationServiceId) || services[0];
      }
      if (service) {
        const endpoint = service.baseUrl;
        return {
          provider: "custom",
          providerLabel: service.name || "自定义服务",
          apiStyle: "chat-completions",
          apiKey: service.apiKey,
          baseUrl: endpoint,
          chatCompletionsUrl: buildChatCompletionsUrl(endpoint),
          generateContentUrl: "",
          model: pickModelId(service, useDedicated ? source.immersiveTranslationModelId : source.translationModelId),
          useJsonResponseFormat: useDedicated
            ? source.immersiveTranslationJsonResponse !== false
            : source.translationJsonResponse !== false,
          includeDeepSeekThinkingFlag: false
        };
      }
    }

    const useImmersiveConfig =
      immersiveRequested && Boolean(String(source.immersiveTranslationProvider || "").trim());
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
    TRANSLATION_SERVICE_PROTOCOLS,
    DEFAULT_CACHE_MAX_ITEMS,
    sourceLanguageLabel,
    targetLanguageLabel,
    buildTechnicalTerminologyInstruction,
    fingerprintText,
    makeCacheKey,
    buildChatCompletionsUrl,
    buildGeminiGenerateContentUrl,
    openAiCompatibleBaseUrl,
    normalizeTranslationServices,
    describeTranslationService,
    buildModelsUrl,
    findTranslationService: findServiceById,
    pickModelId,
    migrateLegacyTranslationServices,
    planTranslationServices,
    resolveTranslationConfig
  });
});
