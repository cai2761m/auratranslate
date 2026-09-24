// Public shared API. Browser dependencies are loaded by manifest.json or HTML.
// Keep require("./shared.js") available to Node tests and local tooling.
(function attachShared(root) {
  "use strict";
  const Shared = typeof module !== "undefined" && module.exports ? {} : root.YTBTShared;
  if (typeof module !== "undefined" && module.exports) {
    require("./shared-settings.js")(Shared);
    require("./shared-runtime.js")(Shared);
    require("./shared-text.js")(Shared);
    require("./shared-captions.js")(Shared);
    require("./shared-translation.js")(Shared);
    require("./shared-segmentation.js")(Shared);
  }
  const api = {
    DEFAULT_SETTINGS: Shared.DEFAULT_SETTINGS,
    FONT_SCALE_MIN: Shared.FONT_SCALE_MIN,
    FONT_SCALE_MAX: Shared.FONT_SCALE_MAX,
    FONT_SCALE_STEP: Shared.FONT_SCALE_STEP,
    normalizeFontScale: Shared.normalizeFontScale,
    DEEPSEEK_MODEL: Shared.DEEPSEEK_MODEL,
    GEMINI_MODEL: Shared.GEMINI_MODEL,
    DEEPSEEK_BASE_URL: Shared.DEEPSEEK_BASE_URL,
    GEMINI_BASE_URL: Shared.GEMINI_BASE_URL,
    TRANSLATION_SERVICE_PROTOCOLS: Shared.TRANSLATION_SERVICE_PROTOCOLS,
    MERGE_VERSION: Shared.MERGE_VERSION,
    SENTENCE_SEGMENTATION_VERSION: Shared.SENTENCE_SEGMENTATION_VERSION,
    DEFAULT_CACHE_MAX_ITEMS: Shared.DEFAULT_CACHE_MAX_ITEMS,
    decodeHtmlEntities: Shared.decodeHtmlEntities,
    normalizeSubtitleText: Shared.normalizeSubtitleText,
    isProtectedVideoContainer: Shared.isProtectedVideoContainer,
    formatDisplaySourceText: Shared.formatDisplaySourceText,
    sourceLanguageLabel: Shared.sourceLanguageLabel,
    targetLanguageLabel: Shared.targetLanguageLabel,
    buildTechnicalTerminologyInstruction: Shared.buildTechnicalTerminologyInstruction,
    classifyTranslationError: Shared.classifyTranslationError,
    isRuntimeConnectionError: Shared.isRuntimeConnectionError,
    sendRuntimeMessage: Shared.sendRuntimeMessage,
    parseJson3Captions: Shared.parseJson3Captions,
    parseVttCaptions: Shared.parseVttCaptions,
    parseVttTime: Shared.parseVttTime,
    parseXmlCaptions: Shared.parseXmlCaptions,
    parseYouTubeTranscriptResponse: Shared.parseYouTubeTranscriptResponse,
    parseYouTubeTranscriptPanelResponse: Shared.parseYouTubeTranscriptPanelResponse,
    parseGoogleDriveTranscriptItems: Shared.parseGoogleDriveTranscriptItems,
    findYouTubeTranscriptParams: Shared.findYouTubeTranscriptParams,
    mergeCaptionFragments: Shared.mergeCaptionFragments,
    splitCaptionCuesAtSentenceBoundaries: Shared.splitCaptionCuesAtSentenceBoundaries,
    parseSentenceSegmentationContent: Shared.parseSentenceSegmentationContent,
    applySentenceSegmentationGroups: Shared.applySentenceSegmentationGroups,
    findCueAtTime: Shared.findCueAtTime,
    fingerprintText: Shared.fingerprintText,
    makeCacheKey: Shared.makeCacheKey,
    buildChatCompletionsUrl: Shared.buildChatCompletionsUrl,
    buildGeminiGenerateContentUrl: Shared.buildGeminiGenerateContentUrl,
    openAiCompatibleBaseUrl: Shared.openAiCompatibleBaseUrl,
    normalizeTranslationServices: Shared.normalizeTranslationServices,
    describeTranslationService: Shared.describeTranslationService,
    buildModelsUrl: Shared.buildModelsUrl,
    findTranslationService: Shared.findTranslationService,
    pickModelId: Shared.pickModelId,
    migrateLegacyTranslationServices: Shared.migrateLegacyTranslationServices,
    planTranslationServices: Shared.planTranslationServices,
    resolveTranslationConfig: Shared.resolveTranslationConfig,
    parseDeepSeekTranslationContent: Shared.parseDeepSeekTranslationContent
  };
  root.YTBTCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
