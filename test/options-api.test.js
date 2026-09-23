const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../src/shared.js");

async function openSettings(t, storage) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../options/options.html"), "utf8"), {
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  dom.window.YTBTCore = Core;
  dom.window.chrome = { storage: { local: {
    get(defaults, callback) { callback({ ...defaults, ...storage }); },
    set(values, callback) { Object.assign(storage, values); callback(); }
  } } };
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../options/options.js"), "utf8"));
  await Promise.resolve();
  return {
    field: (id) => dom.window.document.getElementById(id),
    async save() {
      dom.window.document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await Promise.resolve();
    }
  };
}

test("legacy DeepSeek settings save as a compatible API without losing credentials or defaults", async (t) => {
  const storage = { deepseekApiKey: "legacy-test-key", immersiveTranslationProvider: "deepseek", immersiveTranslationApiKey: "web-test-key" };
  const page = await openSettings(t, storage);
  assert.equal(page.field("translationProvider").value, "custom");
  assert.equal(page.field("immersiveTranslationProvider").value, "custom");
  await page.save();
  for (const profile of [undefined, "immersive"]) {
    const config = Core.resolveTranslationConfig(storage, profile);
    assert.equal(config.provider, "custom");
    assert.equal(config.apiKey, profile ? "web-test-key" : "legacy-test-key");
    assert.equal(config.baseUrl, Core.DEEPSEEK_BASE_URL);
    assert.equal(config.model, Core.DEEPSEEK_MODEL);
    assert.equal(config.apiStyle, "chat-completions");
  }
});

test("legacy Gemini settings save with the OpenAI-compatible endpoint and original model", async (t) => {
  const storage = {
    translationProvider: "gemini", translationApiKey: "test-key", translationModel: "saved-model",
    immersiveTranslationProvider: "gemini", immersiveTranslationApiKey: "web-key",
    immersiveTranslationBaseUrl: `${Core.GEMINI_BASE_URL}/models/web-model:generateContent`,
    immersiveTranslationModel: "web-model"
  };
  const page = await openSettings(t, storage);
  await page.save();
  for (const profile of [undefined, "immersive"]) {
    const config = Core.resolveTranslationConfig(storage, profile);
    assert.equal(config.provider, "custom");
    assert.equal(config.chatCompletionsUrl, `${Core.GEMINI_BASE_URL}/openai/chat/completions`);
    assert.equal(config.apiKey, profile ? "web-key" : "test-key");
    assert.equal(config.model, profile ? "web-model" : "saved-model");
  }
});

test("custom API round trip preserves values and immersive inheritance can be switched", async (t) => {
  const storage = {
    translationProvider: "custom", translationApiKey: "test-key", translationBaseUrl: "https://example.com/v1",
    translationModel: "saved-model", translationJsonResponse: false
  };
  const page = await openSettings(t, storage);
  assert.equal(page.field("immersiveTranslationProvider").value, "");
  await page.save();
  assert.equal(Core.resolveTranslationConfig(storage, "immersive").apiKey, "test-key");
  assert.equal(Core.resolveTranslationConfig(storage).useJsonResponseFormat, false);
  page.field("immersiveTranslationProvider").value = "custom";
  page.field("immersiveTranslationApiKey").value = "web-key";
  page.field("immersiveTranslationBaseUrl").value = "https://web.example.com/v1";
  page.field("immersiveTranslationModel").value = "web-model";
  await page.save();
  const reopened = await openSettings(t, storage);
  assert.equal(reopened.field("immersiveTranslationApiKey").value, "web-key");
  assert.equal(reopened.field("translationBaseUrl").value, "https://example.com/v1");
  assert.equal(reopened.field("translationModel").value, "saved-model");
  reopened.field("immersiveTranslationProvider").value = "";
  await reopened.save();
  assert.equal(Core.resolveTranslationConfig(storage, "immersive").baseUrl, "https://example.com/v1");
});
