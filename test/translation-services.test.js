const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/shared.js");

test("services normalize their model catalogs and drop duplicates", () => {
  const [service] = Core.normalizeTranslationServices([
    {
      id: "s1",
      name: " 中转 ",
      baseUrl: " https://cf.example.cc/v1 ",
      apiKey: " sk-a ",
      models: [{ id: "gpt-6-astra", displayName: " Astra " }, { id: "gpt-6-astra" }, { id: "  " }, { id: "gpt-5" }]
    }
  ]);

  assert.equal(service.name, "中转");
  assert.equal(service.baseUrl, "https://cf.example.cc/v1");
  assert.equal(service.apiKey, "sk-a");
  assert.equal(service.apiProtocol, "openai-compatible", "unknown protocols fall back to the compatible one");
  assert.deepEqual(service.models, [{ id: "gpt-6-astra", displayName: "Astra" }, { id: "gpt-5", displayName: "" }]);
});

test("legacy single-provider settings migrate into editable services", () => {
  const plan = Core.planTranslationServices({ deepseekApiKey: "old-key" });
  assert.equal(plan.migrated, true);
  assert.equal(plan.services.length, 1);
  assert.equal(plan.services[0].name, "DeepSeek");
  assert.equal(plan.services[0].apiKey, "old-key");
  assert.equal(plan.services[0].baseUrl, Core.DEEPSEEK_BASE_URL);
  assert.equal(plan.translationServiceId, "legacy-realtime");
  assert.equal(plan.translationModelId, Core.DEEPSEEK_MODEL);
  assert.equal(plan.immersiveTranslationServiceId, "", "immersive inherits by default");

  const shared = Core.planTranslationServices({
    translationProvider: "custom",
    translationApiKey: "key",
    translationBaseUrl: "https://a.example/v1",
    translationModel: "m1",
    immersiveTranslationProvider: "custom",
    immersiveTranslationApiKey: "key",
    immersiveTranslationBaseUrl: "https://a.example/v1",
    immersiveTranslationModel: "m1"
  });
  assert.equal(shared.services.length, 1, "identical credentials are not duplicated");
  assert.equal(shared.immersiveTranslationServiceId, "legacy-realtime");

  assert.equal(Core.planTranslationServices({}).services.length, 0, "a fresh install has no services");
});

test("a stale or missing selection falls back to an existing service", () => {
  const settings = {
    translationServices: [
      { id: "service-1", name: "A", baseUrl: "https://a/v1", apiKey: "ka", models: [{ id: "ma" }] },
      { id: "service-2", name: "B", baseUrl: "https://b/v1", apiKey: "kb", models: [{ id: "mb" }] }
    ],
    translationServiceId: "deleted-service",
    translationModelId: "missing-model",
    immersiveTranslationServiceId: "deleted-service"
  };

  const plan = Core.planTranslationServices(settings);
  assert.equal(plan.translationServiceId, "service-1");
  assert.equal(plan.translationModelId, "ma", "the first catalog entry is used when the model is gone");
  assert.equal(plan.immersiveTranslationServiceId, "", "a deleted dedicated service falls back to inheriting");

  const config = Core.resolveTranslationConfig(settings, "immersive");
  assert.equal(config.apiKey, "ka");
  assert.equal(config.model, "ma");
});

test("the provider list decides the endpoint, key and model for both pages", () => {
  const settings = {
    translationServices: [
      { id: "service-1", name: "主服务", baseUrl: "https://a.example/v1/", apiKey: "key-a", models: [{ id: "model-a" }, { id: "model-a2" }] },
      { id: "service-2", name: "网页服务", baseUrl: "https://b.example/v1", apiKey: "key-b", models: [{ id: "model-b" }] }
    ],
    translationServiceId: "service-1",
    translationModelId: "model-a2",
    translationJsonResponse: false
  };

  const realtime = Core.resolveTranslationConfig(settings);
  assert.equal(realtime.provider, "custom");
  assert.equal(realtime.providerLabel, "主服务");
  assert.equal(realtime.apiKey, "key-a");
  assert.equal(realtime.chatCompletionsUrl, "https://a.example/v1/chat/completions");
  assert.equal(realtime.model, "model-a2");
  assert.equal(realtime.useJsonResponseFormat, false);
  assert.equal(realtime.includeDeepSeekThinkingFlag, false);

  const inherited = Core.resolveTranslationConfig(settings, "immersive");
  assert.equal(inherited.apiKey, "key-a");
  assert.equal(inherited.model, "model-a2");

  const dedicated = Core.resolveTranslationConfig(
    {
      ...settings,
      immersiveTranslationServiceId: "service-2",
      immersiveTranslationModelId: "model-b",
      immersiveTranslationJsonResponse: false
    },
    "immersive"
  );
  assert.equal(dedicated.apiKey, "key-b");
  assert.equal(dedicated.model, "model-b");
  assert.equal(dedicated.useJsonResponseFormat, false);
  assert.equal(Core.resolveTranslationConfig({ ...settings, immersiveTranslationServiceId: "service-2" }).apiKey, "key-a", "no profile means realtime");
});

test("a selected service wins over stale legacy mirrors", () => {
  const config = Core.resolveTranslationConfig({
    translationServices: [{ id: "service-1", name: "A", baseUrl: "https://a/v1", apiKey: "fresh", models: [{ id: "m" }] }],
    translationServiceId: "service-1",
    translationApiKey: "stale",
    translationBaseUrl: "https://stale/v1",
    translationModel: "stale-model",
    translationProvider: "deepseek"
  });
  assert.equal(config.apiKey, "fresh");
  assert.equal(config.baseUrl, "https://a/v1");
  assert.equal(config.model, "m");
});

test("settings without a provider list keep the legacy provider semantics", () => {
  assert.equal(Core.resolveTranslationConfig({ deepseekApiKey: "old-key" }).provider, "deepseek");
  assert.equal(Core.resolveTranslationConfig({ translationProvider: "gemini", translationApiKey: "g" }).apiStyle, "gemini");
  assert.equal(
    Core.resolveTranslationConfig({ translationProvider: "custom", translationApiKey: "k", translationBaseUrl: "https://legacy/v1", translationModel: "lm" }).model,
    "lm"
  );
});

test("service descriptions and model URLs follow the endpoint", () => {
  assert.equal(Core.describeTranslationService({ baseUrl: "" }), "待完善");
  assert.equal(
    Core.describeTranslationService({ baseUrl: "https://cf.example.cc/v1", models: [{ id: "m" }] }),
    "cf.example.cc · OpenAI-compatible API · 1 个模型"
  );
  assert.equal(
    Core.describeTranslationService({ baseUrl: "https://cf.example.cc/v1", models: [] }),
    "cf.example.cc · OpenAI-compatible API · 尚未添加模型"
  );

  assert.equal(Core.buildModelsUrl("https://cf.example.cc/v1/"), "https://cf.example.cc/v1/models");
  assert.equal(Core.buildModelsUrl("https://cf.example.cc/v1/chat/completions"), "https://cf.example.cc/v1/models");
  assert.equal(Core.buildModelsUrl(""), "");
});

test("legacy Gemini endpoints are rewritten to the compatible sibling", () => {
  assert.equal(
    Core.openAiCompatibleBaseUrl(`${Core.GEMINI_BASE_URL}/models/gemini-3.5-flash:generateContent`, "gemini"),
    `${Core.GEMINI_BASE_URL}/openai`
  );
  assert.equal(Core.openAiCompatibleBaseUrl("https://api.example.com/v1", "custom"), "https://api.example.com/v1");
});

test("model selection helpers ignore unknown ids and empty catalogs", () => {
  const service = { models: [{ id: "a" }, { id: "b" }] };
  assert.equal(Core.pickModelId(service, "b"), "b");
  assert.equal(Core.pickModelId(service, "zzz"), "a");
  assert.equal(Core.pickModelId({ models: [] }, "b"), "");
  assert.equal(Core.findTranslationService([{ id: "s1" }], "s1").id, "s1");
  assert.equal(Core.findTranslationService([{ id: "s1" }], "s2"), null);
});