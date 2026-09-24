const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../src/shared.js");

const root = path.resolve(__dirname, "..");

test("Google fallback is opt-in and both modes preserve their independent Cloud key", async (t) => {
  const storage = {};
  const page = await openSettings(t, storage);
  assert.equal(page.field("immersiveFallbackProvider").value, "off");
  assert.equal(page.field("immersiveGoogleApiKey").closest("label").hidden, true);
  page.field("immersiveFallbackProvider").value = "google-cloud";
  const selector = page.field("immersiveFallbackProvider");
  selector.dispatchEvent(new selector.ownerDocument.defaultView.Event("change"));
  assert.equal(page.field("immersiveGoogleApiKey").closest("label").hidden, false);
  page.field("immersiveGoogleApiKey").value = " cloud-test-key ";
  await page.save();
  assert.equal(storage.immersiveFallbackProvider, "google-cloud");
  assert.equal(storage.immersiveGoogleApiKey, "cloud-test-key");
  const reopened = await openSettings(t, storage);
  assert.equal(reopened.field("immersiveFallbackProvider").value, "google-cloud");
  reopened.field("immersiveFallbackProvider").value = "google-free";
  await reopened.save();
  assert.equal(storage.immersiveFallbackProvider, "google-free");
  assert.equal(storage.immersiveGoogleApiKey, "cloud-test-key");
});

test("legacy DeepSeek credentials become an editable service and keep translating", async (t) => {
  const storage = { deepseekApiKey: "legacy-test-key" };
  const page = await openSettings(t, storage);
  const card = page.document.querySelector(".service-card");
  assert.ok(card, "the legacy key is shown as a service");
  assert.match(card.textContent, /DeepSeek/);
  assert.equal(page.field("translationServiceId").value, "legacy-realtime");

  await page.save();
  assert.equal(storage.translationServices.length, 1);
  assert.equal(storage.translationServices[0].apiKey, "legacy-test-key");
  assert.equal(storage.translationServiceId, "legacy-realtime");
  assert.equal(storage.translationModelId, Core.DEEPSEEK_MODEL);
  const config = Core.resolveTranslationConfig(storage);
  assert.equal(config.provider, "custom");
  assert.equal(config.apiKey, "legacy-test-key");
  assert.equal(config.baseUrl, Core.DEEPSEEK_BASE_URL);
  assert.equal(config.model, Core.DEEPSEEK_MODEL);
  assert.equal(config.chatCompletionsUrl, `${Core.DEEPSEEK_BASE_URL}/chat/completions`);
  assert.equal(Core.resolveTranslationConfig(storage, "immersive").apiKey, "legacy-test-key");
});

test("legacy Gemini settings migrate to the OpenAI-compatible endpoint with their model", async (t) => {
  const storage = {
    translationProvider: "gemini", translationApiKey: "test-key", translationModel: "saved-model",
    immersiveTranslationProvider: "gemini", immersiveTranslationApiKey: "web-key",
    immersiveTranslationBaseUrl: `${Core.GEMINI_BASE_URL}/models/web-model:generateContent`,
    immersiveTranslationModel: "web-model"
  };
  const page = await openSettings(t, storage);
  await page.save();
  assert.equal(storage.translationServices.length, 2, "dedicated immersive credentials stay separate");
  const realtime = Core.resolveTranslationConfig(storage);
  assert.equal(realtime.chatCompletionsUrl, `${Core.GEMINI_BASE_URL}/openai/chat/completions`);
  assert.equal(realtime.apiKey, "test-key");
  assert.equal(realtime.model, "saved-model");
  const immersive = Core.resolveTranslationConfig(storage, "immersive");
  assert.equal(immersive.chatCompletionsUrl, `${Core.GEMINI_BASE_URL}/openai/chat/completions`);
  assert.equal(immersive.apiKey, "web-key");
  assert.equal(immersive.model, "web-model");
});

test("a service built in the dialog drives the subtitle and immersive pages", async (t) => {
  const storage = {};
  const page = await openSettings(t, storage);

  page.document.getElementById("add-service").click();
  assert.equal(page.field("service-dialog").hidden, false);
  assert.equal(page.field("service-dialog-title").textContent, "添加自定义供应方");
  page.field("service-name").value = "中转服务";
  page.field("service-base-url").value = "https://cf.example.cc/v1";
  page.field("service-api-key").value = "sk-astra";
  assert.equal(page.field("service-protocol").value, "openai-compatible");
  assert.equal(page.document.querySelectorAll(".model-row").length, 1);
  page.document.querySelector(".model-id").value = "gpt-6-astra";
  page.document.querySelector(".model-display-name").value = "Astra";
  page.document.getElementById("add-model-row").click();
  const ids = page.document.querySelectorAll(".model-id");
  ids[ids.length - 1].value = "gpt-5";
  page.document.getElementById("save-service").click();
  assert.equal(page.field("service-dialog").hidden, true);

  const card = page.document.querySelector(".service-card");
  assert.match(card.textContent, /中转服务/);
  assert.match(card.textContent, /cf\.example\.cc/);
  assert.match(card.textContent, /gpt-6-astra/);
  assert.match(card.textContent, /Astra/);

  assert.equal(page.field("translationServiceId").value, "service-1");
  assert.equal(page.field("translationModelId").value, "gpt-6-astra");
  await page.save();

  const config = Core.resolveTranslationConfig(storage);
  assert.equal(config.apiKey, "sk-astra");
  assert.equal(config.baseUrl, "https://cf.example.cc/v1");
  assert.equal(config.model, "gpt-6-astra");
  assert.equal(config.providerLabel, "中转服务");

  const reopened = await openSettings(t, storage);
  assert.equal(reopened.field("translationServiceId").value, "service-1");
  assert.equal(reopened.field("translationModelId").value, "gpt-6-astra");
  assert.equal(reopened.document.querySelectorAll(".service-model").length, 2);
});

test("immersive translation inherits the realtime service until one is picked", async (t) => {
  const storage = {
    translationServices: [
      { id: "service-1", name: "主服务", baseUrl: "https://a.example/v1", apiKey: "key-a", models: [{ id: "model-a", displayName: "" }] },
      { id: "service-2", name: "网页服务", baseUrl: "https://b.example/v1", apiKey: "key-b", models: [{ id: "model-b", displayName: "" }] }
    ],
    translationServiceId: "service-1",
    translationModelId: "model-a"
  };
  const page = await openSettings(t, storage);
  assert.equal(page.field("immersiveTranslationServiceId").value, "");
  assert.equal(page.field("immersiveTranslationModelId").value, "model-a", "inherited model is shown");

  page.field("immersiveTranslationServiceId").value = "service-2";
  page.field("immersiveTranslationServiceId").dispatchEvent(new page.window.Event("change"));
  assert.equal(page.field("immersiveTranslationModelId").value, "model-b");
  await page.save();
  assert.equal(storage.immersiveTranslationServiceId, "service-2");
  assert.equal(Core.resolveTranslationConfig(storage, "immersive").apiKey, "key-b");
  assert.equal(Core.resolveTranslationConfig(storage).apiKey, "key-a");

  page.field("immersiveTranslationServiceId").value = "";
  page.field("immersiveTranslationServiceId").dispatchEvent(new page.window.Event("change"));
  await page.save();
  assert.equal(storage.immersiveTranslationServiceId, "");
  assert.equal(storage.immersiveTranslationApiKey, "", "the legacy mirror is cleared when inheriting");
  assert.equal(Core.resolveTranslationConfig(storage, "immersive").apiKey, "key-a");
});

test("deleting a service clears the selections that pointed at it", async (t) => {
  const storage = {
    translationServices: [
      { id: "service-1", name: "主服务", baseUrl: "https://a.example/v1", apiKey: "key-a", models: [{ id: "model-a", displayName: "" }] },
      { id: "service-2", name: "备用", baseUrl: "https://b.example/v1", apiKey: "key-b", models: [{ id: "model-b", displayName: "" }] }
    ],
    translationServiceId: "service-2"
  };
  const page = await openSettings(t, storage);
  const buttons = [...page.document.querySelectorAll('[data-action="delete-service"]')];
  buttons[1].click();
  assert.equal(page.field("translationServiceId").value, "service-1");
  await page.save();
  assert.equal(storage.translationServices.length, 1);
  assert.equal(storage.translationApiKey, "key-a");
  assert.equal(Core.resolveTranslationConfig(storage).apiKey, "key-a");
});

test("获取可用模型 fills the catalog from the provider model endpoint", async (t) => {
  const storage = {};
  const page = await openSettings(t, storage);
  const requests = [];
  page.window.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ data: [{ id: "gpt-6-astra" }, { id: "gpt-5" }] }) };
  };

  page.document.getElementById("add-service").click();
  page.field("service-name").value = "中转服务";
  page.field("service-base-url").value = "https://cf.example.cc/v1";
  page.field("service-api-key").value = "sk-astra";
  page.document.getElementById("fetch-models").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://cf.example.cc/v1/models");
  assert.equal(requests[0].options.headers.Authorization, "Bearer sk-astra");
  assert.deepEqual(
    [...page.document.querySelectorAll(".model-id")].map((input) => input.value),
    ["gpt-6-astra", "gpt-5"]
  );
  assert.match(page.field("service-models-status").textContent, /接口返回 2 个模型/);

  page.document.getElementById("save-service").click();
  await page.save();
  assert.equal(Core.resolveTranslationConfig(storage).model, "gpt-6-astra");
});

test("a failing model request keeps the manual catalog and explains the error", async (t) => {
  const page = await openSettings(t, {});
  page.window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

  page.document.getElementById("add-service").click();
  page.field("service-base-url").value = "https://cf.example.cc/v1";
  page.document.querySelector(".model-id").value = "manual-model";
  page.document.getElementById("fetch-models").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(page.field("service-models-status").textContent, /获取失败（HTTP 401）/);
  assert.equal(page.document.querySelector(".model-id").value, "manual-model");
});

async function openSettings(t, storage) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "options/options.html"), "utf8"), {
    url: "https://example.com/options/options.html",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  dom.window.YTBTCore = Core;
  dom.window.chrome = { storage: { local: {
    get(defaults, callback) { callback({ ...defaults, ...storage }); },
    set(values, callback) { Object.assign(storage, values); callback(); },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      callback();
    }
  } } };
  dom.window.eval(fs.readFileSync(path.join(root, "options/options.js"), "utf8"));
  await Promise.resolve();
  return {
    document: dom.window.document,
    window: dom.window,
    field: (id) => dom.window.document.getElementById(id),
    async save() {
      dom.window.document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await Promise.resolve();
    }
  };
}