const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const Core = require("../src/shared.js");

function fixture(stallBody) {
  const timers = new Map();
  let serial = 0;
  let fetchCount = 0;
  let bodyStarted = false;
  const context = vm.createContext({
    YTBTCore: Core, AbortController,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(_url, { signal }) {
      fetchCount += 1;
      return { ok: true, status: 200, text() {
        bodyStarted = true;
        if (!stallBody) return Promise.resolve("response body");
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted"))));
      } };
    }
  });
  require("../scripts/extension-scripts.cjs").loadBackground(context);
  return { context, timers, get fetchCount() { return fetchCount; }, get bodyStarted() { return bodyStarted; } };
}

test("provider deadline covers stalled response bodies and does not replay a possibly billed call", async () => {
  const f = fixture(true);
  const result = f.context.translateWithRetry({
    translationConfig: Core.resolveTranslationConfig({ ...Core.DEFAULT_SETTINGS, deepseekApiKey: "fake-key" }),
    sourceLanguage: "en", targetLanguage: "zh-CN", mode: "immersive",
    cues: [{ id: "1", sourceText: "This is an English paragraph." }]
  });
  const rejected = assert.rejects(result, /翻译接口响应超时.*可能已经计费/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.bodyStarted, true);
  assert.equal(f.timers.size, 1, "receiving headers must not clear the body deadline");
  const timer = [...f.timers.values()][0];
  assert.equal(timer.ms, 60000);
  timer.callback();
  await rejected;
  assert.equal(f.fetchCount, 1);
  assert.equal(f.timers.size, 0);
});

test("fully consumed responses clear their deadline and preserve the body", async () => {
  const f = fixture(false);
  const result = await f.context.fetchWithTimeout("https://example.test", {});
  assert.equal(result.response.status, 200);
  assert.equal(result.bodyText, "response body");
  assert.equal(f.timers.size, 0);
});

test("an uncertain AI timeout switches to free Google exactly once without replaying AI", async () => {
  const f = fixture(true);
  const retained = [];
  const result = f.context.translateImmersiveWithFallback({
    translationConfig: Core.resolveTranslationConfig({ ...Core.DEFAULT_SETTINGS, deepseekApiKey: "fake-key" }),
    sourceLanguage: "en", targetLanguage: "zh-CN", mode: "immersive",
    cues: [{ id: "1", sourceText: "This is an English paragraph." }]
  }, { immersiveFallbackProvider: "google-free" }, async (items) => retained.push(...items));
  await new Promise((resolve) => setImmediate(resolve));
  let googleCalls = 0;
  f.context.fetch = async (url) => {
    assert.match(url, /^https:\/\/translate.googleapis.com\//);
    googleCalls++;
    return { ok: true, text: async () => JSON.stringify([[["谷歌译文"]]]) };
  };
  [...f.timers.values()][0].callback();
  assert.equal((await result)[0].translatedText, "谷歌译文");
  assert.equal(retained.length, 1);
  assert.equal(f.fetchCount, 1);
  assert.equal(googleCalls, 1);
  assert.equal(f.timers.size, 0);
});

test("both Google modes bound stalled response bodies and never retry", async (t) => {
  for (const mode of ["google-free", "google-cloud"]) {
    await t.test(mode, async () => {
      const f = fixture(true);
      const result = f.context.translateImmersiveWithFallback({
        translationConfig: Core.resolveTranslationConfig(Core.DEFAULT_SETTINGS),
        sourceLanguage: "en", targetLanguage: "zh-CN", mode: "immersive",
        cues: [{ id: "1", sourceText: "An English paragraph." }]
      }, { immersiveFallbackProvider: mode, immersiveGoogleApiKey: "cloud-key" }, async () => {});
      const rejected = assert.rejects(result, (error) => {
        assert.match(error.message, /Google 兜底失败.*超时/);
        assert.equal(error.requestMayHaveReachedProvider, mode === "google-cloud");
        return true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      const timer = [...f.timers.values()][0];
      assert.equal(timer.ms, 15000);
      timer.callback();
      await rejected;
      assert.equal(f.fetchCount, 1);
      assert.equal(f.timers.size, 0);
    });
  }
});
