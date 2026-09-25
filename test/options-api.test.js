const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../src/shared.js");

const root = path.resolve(__dirname, "..");

test("removed webpage fallback setting and saved credentials are cleared", async (t) => {
  const storage = { immersiveFallbackProvider: "bing-free", immersiveGoogleApiKey: "old-key" };
  const page = await openSettings(t, storage);
  assert.equal(page.field("immersiveFallbackProvider"), null);
  await page.save();
  assert.equal(storage.immersiveFallbackProvider, undefined);
  assert.equal(storage.immersiveGoogleApiKey, undefined);
});

test("legacy DeepSeek credentials become an editable service and keep translating", async (t) => {
  const storage = { deepseekApiKey: "legacy-test-key" };
  const page = await openSettings(t, storage);
  const card = page.document.querySelector(".service-entry");
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

  const card = page.field("service-detail");
  assert.match(card.textContent, /中转服务/);
  assert.equal(page.field("detail-base-url").value, "https://cf.example.cc/v1");
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
  page.document.querySelector('[data-select-service="service-2"]').click();
  page.field("delete-service").click();
  assert.equal(page.field("translationServiceId").value, "service-1");
  await page.save();
  assert.equal(storage.translationServices.length, 1);
  assert.equal(storage.translationApiKey, "key-a");
  assert.equal(Core.resolveTranslationConfig(storage).apiKey, "key-a");
});

test("获取模型列表 opens a picker and only adds checked models", async (t) => {
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
  assert.equal(page.field("model-picker-dialog").hidden, false);
  assert.deepEqual(
    [...page.field("model-picker-list").querySelectorAll(".model-picker-item-name")].map((item) => item.textContent),
    ["gpt-6-astra", "gpt-5"]
  );
  assert.deepEqual([...page.document.querySelectorAll(".model-id")].map((input) => input.value), [""]);
  const checkboxes = page.field("model-picker-list").querySelectorAll("input[type='checkbox']");
  checkboxes[1].checked = true;
  checkboxes[1].dispatchEvent(new page.window.Event("change", { bubbles: true }));
  page.field("model-picker-add").click();
  assert.deepEqual([...page.document.querySelectorAll(".model-id")].map((input) => input.value), ["gpt-5"]);

  page.document.getElementById("save-service").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Array.from(storage.translationServices[0].models, (model) => model.id), ["gpt-5"]);
});

test("cancelling model selection leaves the provider draft unchanged", async (t) => {
  const page = await openSettings(t, serviceFixture());
  page.document.querySelector('[data-select-service="service-1"]').click();
  page.field("edit-service").click();
  page.field("service-base-url").value = "https://a.example/v1";
  page.window.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "model-a" }, { id: "model-new" }] }) });
  page.field("fetch-models").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.field("model-picker-dialog").hidden, false);
  const newModel = page.field("model-picker-list").querySelectorAll("input[type='checkbox']")[1];
  newModel.checked = true;
  newModel.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  page.field("model-picker-cancel").click();

  assert.equal(page.field("model-picker-dialog").hidden, true);
  assert.equal(page.field("service-dialog").hidden, false);
  assert.deepEqual([...page.document.querySelectorAll(".model-id")].map((input) => input.value), ["model-a"]);
  page.field("cancel-service").click();
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

function serviceFixture() {
  return {
    translationServices: [
      { id: "service-1", name: "备用服务", baseUrl: "https://a.example/v1", apiKey: "key-a", models: [{ id: "model-a", displayName: "别名 A" }] },
      { id: "service-2", name: "默认服务", baseUrl: "https://b.example/v1", apiKey: "key-b", models: [{ id: "model-b", displayName: "" }] }
    ],
    translationServiceId: "service-2"
  };
}

test("custom services stay in their group when selected as defaults", async (t) => {
  const storage = serviceFixture();
  const page = await openSettings(t, storage);
  assert.deepEqual([...page.field("custom-service-list").querySelectorAll("[data-select-service]")].map((el) => el.dataset.selectService),
    ["service-2", "service-1"]);
  assert.match(page.document.querySelector('[data-select-service="service-2"]').textContent, /默认/);
  assert.equal(page.field("detail-name").textContent, "默认服务");
  page.document.querySelector('[data-select-service="service-1"]').click();
  assert.equal(page.field("detail-name").textContent, "备用服务");
  assert.equal(page.field("translationServiceId").value, "service-2");
  assert.equal(page.document.querySelectorAll('[data-select-service][aria-current="true"]').length, 1);
  page.field("detail-api-key").value = "edited-key";
  page.field("detail-api-key").dispatchEvent(new page.window.Event("input"));
  page.field("detail-base-url").value = "https://edited.example/v1";
  page.field("detail-base-url").dispatchEvent(new page.window.Event("input"));
  page.document.querySelector('[data-select-service="service-2"]').click();
  page.document.querySelector('[data-select-service="service-1"]').click();
  assert.equal(page.field("detail-api-key").value, "edited-key");
  await page.save();
  assert.equal(storage.translationServices[0].apiKey, "edited-key");
  assert.equal(storage.translationServices[0].baseUrl, "https://edited.example/v1");
  assert.equal(storage.translationServiceId, "service-2");
  page.field("translationServiceId").value = "service-1";
  page.field("translationServiceId").dispatchEvent(new page.window.Event("change"));
  assert.equal(page.document.querySelector('#custom-service-list [data-select-service="service-1"]').dataset.selectService, "service-1");
});

test("service details stay hidden until a custom provider is selected", async (t) => {
  const storage = {};
  const page = await openSettings(t, storage);
  assert.equal(page.field("service-detail").hidden, true);
});

test("detail model fetch lets the user pick models and skips existing ids", async (t) => {
  const storage = serviceFixture();
  const page = await openSettings(t, storage);
  page.document.querySelector('[data-select-service="service-1"]').click();
  page.window.fetch = async (url, options) => {
    assert.equal(url, "https://a.example/v1/models");
    assert.equal(options.headers.Authorization, "Bearer key-a");
    return { ok: true, json: async () => ({ data: [{ id: "model-a" }, { id: "new-model" }, { id: "new-model" }] }) };
  };
  page.field("detail-fetch-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.field("model-picker-dialog").hidden, false);
  const choices = [...page.field("model-picker-list").querySelectorAll(".model-picker-item")];
  assert.equal(choices.length, 2);
  assert.equal(choices[0].querySelector("input").disabled, true);
  assert.match(choices[0].textContent, /已在目录中/);
  choices[1].querySelector("input").checked = true;
  choices[1].querySelector("input").dispatchEvent(new page.window.Event("change", { bubbles: true }));
  page.field("model-picker-add").click();
  assert.deepEqual([...page.field("detail-models").querySelectorAll(".detail-model-id")].map((input) => input.value), ["model-a", "new-model"]);
  assert.equal(storage.translationServices[0].models[0].displayName, "别名 A");
});

test("model test dialog checks each model and reports individual results", async (t) => {
  const storage = serviceFixture();
  storage.translationServices[0].models.push({ id: "model-b", displayName: "别名 B" });
  const page = await openSettings(t, storage);
  page.document.querySelector('[data-select-service="service-1"]').click();
  const requests = [];
  let activeRequests = 0;
  let peakRequests = 0;
  page.window.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, options, request });
    activeRequests += 1;
    peakRequests = Math.max(peakRequests, activeRequests);
    await new Promise((resolve) => page.window.setTimeout(resolve, 5));
    activeRequests -= 1;
    if (request.model === "model-a") {
      return { ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: "model not found" } }) };
  };

  page.field("detail-test-models").click();
  assert.equal(page.field("model-test-dialog").hidden, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0, "opening the dialog must not send paid requests");
  page.field("start-model-test").click();
  await new Promise((resolve) => page.window.setTimeout(resolve, 20));

  assert.equal(requests.length, 2);
  assert.equal(peakRequests, 2, "both model checks should be in flight together");
  assert.deepEqual(requests.map(({ request }) => request.model), ["model-a", "model-b"]);
  assert.ok(requests.every(({ url }) => url === "https://a.example/v1/chat/completions"));
  assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer key-a"));
  assert.deepEqual([...page.field("model-test-results").querySelectorAll(".model-test-result")]
    .map((item) => item.dataset.state), ["success", "error"]);
  assert.match(page.field("model-test-results").textContent, /HTTP 404/);
  assert.match(page.field("model-test-results").textContent, /\d+ ms/);
  assert.equal(page.field("model-test-progress"), null);
  const savedResults = page.field("model-test-results").textContent;

  page.field("close-model-test").click();
  assert.equal(page.field("model-test-dialog").hidden, true);
  assert.equal(page.field("settings-form").inert, false);
  page.field("detail-test-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.field("model-test-results").textContent, savedResults);
  assert.equal(requests.length, 2);
  const reopened = await openSettings(t, storage);
  reopened.document.querySelector('[data-select-service="service-1"]').click();
  reopened.field("detail-test-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.field("model-test-results").textContent, savedResults);
});

test("saved model latencies keep their colors during retests and are isolated by endpoint", async (t) => {
  const storage = serviceFixture();
  const service = storage.translationServices[0];
  service.models = ["fast", "medium", "slow"].map((id) => ({ id }));
  [250, 5000, 15000].forEach((latencyMs, index) => {
    storage["modelTestResult:" + JSON.stringify([service.id, service.baseUrl, service.models[index].id])] =
      { state: "success", message: "", latencyMs, testedAt: Date.now() };
  });
  const page = await openSettings(t, storage);
  page.document.querySelector('[data-select-service="service-1"]').click();
  const pending = [];
  page.window.fetch = (url, options) => new Promise((resolve) => pending.push({ resolve, options }));
  page.field("detail-test-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...page.field("model-test-results").children].map((row) => row.dataset.latency), ["fast", "medium", "slow"]);
  page.field("start-model-test").click();
  assert.equal(pending.length, 3);
  assert.match(page.field("model-test-results").textContent, /250 ms/);
  assert.match(page.field("model-test-results").textContent, /测试中/);
  page.field("close-model-test").click();
  assert.ok(pending.every(({ options }) => options.signal.aborted));
  page.field("detail-base-url").value = "https://changed.example/v1";
  page.field("detail-base-url").dispatchEvent(new page.window.Event("input"));
  page.field("detail-test-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  pending.forEach(({ resolve }) => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...page.field("model-test-results").children].every((row) => row.dataset.state === "untested"));
  assert.equal(Object.keys(storage).filter((key) => key.startsWith("modelTestResult:")).length, 3);
});

test("parallel model tests stop queued models on close", async (t) => {
  const storage = serviceFixture();
  storage.translationServices[0].models = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const page = await openSettings(t, storage);
  page.document.querySelector('[data-select-service="service-1"]').click();
  const pending = [];
  page.window.fetch = (url, options) => new Promise((resolve) => pending.push({ resolve, options }));
  page.field("detail-test-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  page.field("start-model-test").click();
  assert.equal(pending.length, 3);
  pending[0].resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4, "a completed request frees one slot");
  page.field("close-model-test").click();
  assert.ok(pending.slice(1).every(({ options }) => options.signal.aborted));
  pending.slice(1).forEach(({ resolve }) => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4, "the last queued model must not be sent");
  assert.equal(Object.keys(storage).filter((key) => key.startsWith("modelTestResult:")).length, 1);
});

test("model tests show concise HTML errors and time out stalled response bodies", async (t) => {
  const storage = serviceFixture();
  storage.translationServices[0].models = [{ id: "html" }, { id: "stalled" }];
  const page = await openSettings(t, storage);
  page.document.querySelector('[data-select-service="service-1"]').click();
  const deadlines = [];
  const originalTimeout = page.window.setTimeout.bind(page.window);
  page.window.setTimeout = (callback, delay) => {
    if (delay === 20000) deadlines.push(callback);
    return originalTimeout(callback, delay);
  };
  page.window.fetch = async (url, options) => ({
    ok: true,
    json: () => JSON.parse(options.body).model === "html"
      ? Promise.reject(new SyntaxError("Unexpected token '<', <!DOCTYPE html>"))
      : new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  });
  page.field("detail-test-models").click();
  await new Promise((resolve) => setImmediate(resolve));
  page.field("start-model-test").click();
  await new Promise((resolve) => setImmediate(resolve));
  deadlines[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.field("model-test-results").textContent, /返回非 JSON 数据/);
  assert.match(page.field("model-test-results").textContent, /请求超时/);
  assert.doesNotMatch(page.field("model-test-results").textContent, /DOCTYPE/);
  assert.equal(page.field("start-model-test").disabled, false);
});

test("late detail model responses cannot overwrite the newly selected service", async (t) => {
  const storage = serviceFixture();
  const page = await openSettings(t, storage);
  let finish;
  page.window.fetch = () => new Promise((resolve) => { finish = resolve; });
  page.field("detail-fetch-models").click();
  page.document.querySelector('[data-select-service="service-1"]').click();
  finish({ ok: true, json: async () => ({ data: [{ id: "stale-model" }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(page.field("detail-models").textContent, /stale-model/);
  assert.equal(page.field("detail-name").textContent, "备用服务");
  await page.save();
  assert.equal(storage.translationServices[0].models.length, 1);
  assert.equal(storage.translationServices[1].models.length, 1);
});

test("cancelled dialog ignores late model requests and preserves the saved catalog", async (t) => {
  const page = await openSettings(t, serviceFixture());
  page.field("edit-service").click();
  let finish;
  page.window.fetch = () => new Promise((resolve) => { finish = resolve; });
  page.field("fetch-models").click();
  page.field("cancel-service").click();
  page.field("add-service").click();
  finish({ ok: true, json: async () => ({ data: [{ id: "stale-model" }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.document.querySelector(".model-id").value, "");
  assert.equal(page.field("fetch-models").disabled, false);
  page.field("service-dialog").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(page.field("service-dialog").hidden, true);
  assert.equal(page.field("settings-form").inert, false);
});
