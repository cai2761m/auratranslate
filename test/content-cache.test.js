const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function sharedStorage() {
  const data = {};
  const listeners = [];
  return {
    data,
    operations: [],
    failure: null,
    onChanged: { addListener(listener) { listeners.push(listener); } },
    local: {
      get(keys, callback) {
        setImmediate(() => {
          let result;
          if (keys == null) result = data;
          else if (typeof keys === "string") result = { [keys]: data[keys] };
          else if (Array.isArray(keys)) result = Object.fromEntries(keys.map((key) => [key, data[key]]));
          else result = Object.assign({}, keys, Object.fromEntries(
            Object.keys(keys).filter((key) => key in data).map((key) => [key, data[key]])
          ));
          callback(clone(result));
        });
      },
      set(values, callback) {
        const saved = clone(values);
        setImmediate(() => {
          const changes = {};
          for (const [key, value] of Object.entries(saved)) {
            changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
            data[key] = value;
          }
          callback();
          for (const listener of listeners) listener(clone(changes), "local");
        });
      },
      remove(keys, callback) {
        setImmediate(() => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
          callback();
        });
      }
    }
  };
}

function rawCues(count = 42, prefix = "Sentence") {
  return Array.from({ length: count }, (_, index) => ({
    startMs: index * 10000,
    endMs: index * 10000 + 4000,
    sourceText: `${prefix} number ${index + 1}.`
  }));
}

function playerResponse(videoId = "video-1", changes = {}, cues = rawCues()) {
  return {
    videoId,
    captionTracks: [{
      baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&signature=old-signed-url`,
      languageCode: "en",
      kind: "asr",
      vssId: "a.en",
      name: "English (auto-generated)",
      capturedText: `<transcript>${cues.map((cue) =>
        `<text start="${cue.startMs / 1000}" dur="${(cue.endMs - cue.startMs) / 1000}">${cue.sourceText}</text>`
      ).join("")}</transcript>`,
      ...changes
    }]
  };
}

function translationKey(message, cue, settings) {
  const config = Core.resolveTranslationConfig(settings);
  return JSON.stringify([
    message.videoId, message.trackFingerprint, cue.sourceText,
    config.provider, config.baseUrl, config.model,
    settings.sourceLanguage, settings.targetLanguage,
    settings.asrCorrectionEnabled, settings.showOriginalTechnicalTerms,
    settings.cacheVersion
  ]);
}

function loadContent(storage, translations, options = {}) {
  const calls = { fetch: [], segmentation: [], cacheOnly: [], paid: [], errors: [] };
  const window = {
    location: {
      hostname: options.drive ? "youtube.googleapis.com" : "www.youtube.com",
      origin: options.drive ? "https://youtube.googleapis.com" : "https://www.youtube.com",
      pathname: options.drive ? "/embed/video-1" : "/watch",
      href: "https://www.youtube.com/watch?v=video-1"
    },
    postMessage() {}
  };
  window.parent = window;
  let api;
  const context = vm.createContext({
    AbortController,
    Node: { ELEMENT_NODE: 1 },
    URL,
    YTBTCore: Core,
    btoa,
    clearTimeout,
    chrome: {
      storage,
      runtime: {
        sendMessage(message, callback) {
          const saved = clone(message);
          const type = message.type === "SEGMENT_SUBTITLES"
            ? "segmentation" : message.cacheOnly ? "cacheOnly" : "paid";
          calls[type].push(saved);
          setImmediate(async () => {
            try {
              if (options.beforeResponse) await options.beforeResponse(saved, api);
              if (message.type === "SEGMENT_SUBTITLES") {
                callback({ ok: true, groups: message.cues.map((cue) => ({
                  startId: cue.id, endId: cue.id, displaySourceText: cue.sourceText
                })) });
                return;
              }
              const items = [];
              for (const cue of message.cues) {
                const key = translationKey(message, cue, api.state.settings);
                let item = translations.get(key);
                if (!item && !message.cacheOnly) {
                  item = { translatedText: `译文：${cue.sourceText}`, displaySourceText: `Corrected ${cue.sourceText}` };
                  translations.set(key, clone(item));
                }
                if (item) items.push({ id: cue.id, ...clone(item) });
              }
              callback({ ok: true, items });
            } catch (error) {
              calls.errors.push(error);
              callback({ ok: false, errors: [{ message: error.message }] });
            }
          });
        }
      }
    },
    document: {
      documentElement: { classList: { toggle() {} } },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    },
    async fetch(url) {
      calls.fetch.push(String(url));
      // Exercise the existing captured timedtext fallback without depending on
      // the independently developed modern transcript panel parser.
      return { ok: false, status: 503, async text() { return "Unavailable"; } };
    },
    requestAnimationFrame() {},
    setTimeout,
    window
  });
  const runtime = context.chrome.runtime;
  context.chrome.storage = {
    onChanged: storage.onChanged,
    local: Object.fromEntries(["get", "set", "remove"].map((method) => [method, (values, callback) => {
      storage.operations.push({ method, values: clone(values) });
      const error = storage.failure && storage.failure(method, values);
      if (error) {
        setImmediate(() => {
          runtime.lastError = { message: error };
          try { callback(); } finally { delete runtime.lastError; }
        });
      } else {
        storage.local[method](values, callback);
      }
    }]))
  };
  let source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  source = source.replace(
    /\r?\n  if \(!IS_DRIVE_PLAYER\) \{\r?\n    bindPageMessages\(\);\r?\n    injectPageBridge\(\);\r?\n  \}\r?\n  init\(\);/,
    "\n  // Tests initialize explicit state in a fresh page context."
  );
  source = source.replace(/\r?\n  init\(\);/, "\n  // Tests initialize explicit state in a fresh page context.");
  source = source.replace(/\n\}\)\(\);\s*$/, `
  globalThis.__cacheTest = {
    state, prepareCaptionCues, handlePlayerResponse, handleDriveTranscript,
    makeStableTrackFingerprint, resetVideoState, bindStorageChanges
  };
})();`);
  vm.runInContext(source, context);
  api = context.__cacheTest;
  api.state.settingsLoaded = true;
  api.state.settings = Object.assign({}, Core.DEFAULT_SETTINGS, {
    deepseekApiKey: "test-api-key-must-not-be-in-snapshot",
    ...options.settings
  });
  return { api, calls, window };
}

async function settle(page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await nextTurn();
    if (!page.api.state.queue.length && !page.api.state.inFlight.size) {
      assert.deepEqual(page.calls.errors, []);
      return;
    }
  }
  assert.fail("Translation queue did not settle");
}

async function seedPage(storage, translations, options = {}) {
  const page = loadContent(storage, translations, options);
  const cues = options.cues || rawCues();
  const payload = options.payload || playerResponse("video-1", {}, cues);
  const fingerprint = page.api.makeStableTrackFingerprint(payload.videoId, payload.captionTracks[0], null);
  page.api.resetVideoState(payload.videoId, payload.captionTracks[0], fingerprint, null);
  await page.api.prepareCaptionCues(cues, payload.videoId, fingerprint, page.api.state.loadingToken, "Test captions");
  await settle(page);
  assert.equal(page.api.state.cues.length, cues.length);
  assert.ok(page.api.state.cues.every((cue) => cue.status === "translated"));
  return page;
}

function viewCues(page) {
  return clone(page.api.state.cues).map(({ id, startMs, endMs, sourceText, displaySourceText, translatedText, status }) => ({
    id, startMs, endMs, sourceText, displaySourceText, translatedText, status
  }));
}

test("refresh restores every translated cue without fetching, segmenting, or paid translation", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const first = await seedPage(storage, translations);
  assert.equal(first.calls.segmentation.length, 1);
  assert.ok(first.calls.paid.length > 1, "fixture must span multiple translation batches");
  const snapshots = Object.entries(storage.data).filter(([key]) => key.startsWith("ytbt:prepared:"));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0][1].cues.length, 42);
  assert.ok(!JSON.stringify(snapshots).includes("test-api-key"));
  assert.ok(!JSON.stringify(snapshots).includes("old-signed-url"));

  const refreshed = loadContent(storage, translations);
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.deepEqual(viewCues(refreshed), viewCues(first));
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
  assert.equal(refreshed.calls.cacheOnly.flatMap((call) => call.cues).length, 42);
});

test("refresh with partial translations pays only for missing cues, including distant cues", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const first = await seedPage(storage, translations);
  const missing = first.api.state.cues.at(-1);
  const missingKey = [...translations.keys()].find((key) => JSON.parse(key)[2] === missing.sourceText);
  assert.ok(missingKey);
  translations.delete(missingKey);

  const refreshed = loadContent(storage, translations);
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.deepEqual(viewCues(refreshed), viewCues(first));
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.deepEqual(refreshed.calls.paid.flatMap((call) => call.cues.map((cue) => cue.sourceText)), [missing.sourceText]);
});

test("localized track labels, refreshed signed URLs, and API key rotation reuse the original translations", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const first = await seedPage(storage, translations);
  const refreshed = loadContent(storage, translations, { settings: { deepseekApiKey: "rotated-api-key" } });
  await refreshed.api.handlePlayerResponse(playerResponse("video-1", {
    name: "英语（自动生成）",
    baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=en&signature=new-signed-url"
  }));
  await settle(refreshed);
  assert.deepEqual(viewCues(refreshed), viewCues(first));
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
  assert.equal(refreshed.calls.cacheOnly[0].trackFingerprint, first.api.state.trackFingerprint);
});

test("model and cache version changes invalidate prepared cues", async (t) => {
  for (const settings of [{ translationModel: "different-model" }, { cacheVersion: "2" }]) {
    await t.test(Object.keys(settings)[0], async () => {
      const storage = sharedStorage();
      const translations = new Map();
      await seedPage(storage, translations);
      const refreshed = loadContent(storage, translations, { settings });
      await refreshed.api.handlePlayerResponse(playerResponse());
      await settle(refreshed);
      assert.ok(refreshed.calls.fetch.length > 0);
      assert.equal(refreshed.calls.segmentation.length, 1);
      assert.equal(refreshed.calls.paid.flatMap((call) => call.cues).length, 42);
      assert.ok(refreshed.api.state.cues.every((cue) => cue.status === "translated"));
    });
  }
});

test("changing target language reuses segmentation and translates into the new target", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  await seedPage(storage, translations);
  const refreshed = loadContent(storage, translations, { settings: { targetLanguage: "zh-TW" } });
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.flatMap((call) => call.cues).length, 42);
});

test("a stale cache response cannot overwrite subtitles after navigation", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  await seedPage(storage, translations);
  const secondCues = rawCues(3, "Next video");
  const nextPayload = playerResponse("video-2", {}, secondCues);
  const nextSeed = await seedPage(storage, translations, { payload: nextPayload, cues: secondCues });
  let releaseOldResponse;
  let signalOldRequest;
  const oldResponse = new Promise((resolve) => { releaseOldResponse = resolve; });
  const oldRequest = new Promise((resolve) => { signalOldRequest = resolve; });
  const refreshed = loadContent(storage, translations, {
    async beforeResponse(message) {
      if (message.cacheOnly && message.videoId === "video-1") {
        signalOldRequest();
        await oldResponse;
      }
    }
  });
  const firstLoad = refreshed.api.handlePlayerResponse(playerResponse());
  await oldRequest;
  refreshed.window.location.href = "https://www.youtube.com/watch?v=video-2";
  await refreshed.api.handlePlayerResponse(nextPayload);
  releaseOldResponse();
  await firstLoad;
  await settle(refreshed);
  assert.equal(refreshed.api.state.videoId, "video-2");
  assert.deepEqual(viewCues(refreshed), viewCues(nextSeed));
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
});

test("Google Drive refresh also restores prepared cues and translations", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const payload = { fileId: "drive-file-1", signature: "transcript-revision-1", cues: rawCues(3) };
  const first = loadContent(storage, translations, { drive: true });
  await first.api.handleDriveTranscript(payload);
  await settle(first);
  assert.equal(first.calls.segmentation.length, 1);
  assert.equal(first.calls.paid.flatMap((call) => call.cues).length, 3);
  const refreshed = loadContent(storage, translations, { drive: true });
  await refreshed.api.handleDriveTranscript(clone(payload));
  await settle(refreshed);
  assert.deepEqual(viewCues(refreshed), viewCues(first));
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
});

test("a failed cache read stops refresh before fetching or paying to recreate subtitles", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  await seedPage(storage, translations);
  storage.failure = (method) => method === "get" ? "Local storage is unavailable" : null;
  const refreshed = loadContent(storage, translations);
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.match(refreshed.api.state.statusText, /Local storage is unavailable/);
  assert.equal(refreshed.api.state.cues.length, 0);
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.cacheOnly.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
});

test("snapshot quota failure evicts the oldest prepared snapshot and retries before translating", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  storage.data["ytbt:prepared:oldest"] = { updatedAt: 1, cues: [] };
  storage.data["ytbt:prepared:newer"] = { updatedAt: 2, cues: [] };
  storage.data["ytbt:translation-sentinel"] = { translatedText: "保留翻译" };
  storage.data.deepseekApiKey = "stored-api-key";
  let snapshotWrites = 0;
  storage.failure = (method, values) => {
    if (method === "set" && Object.keys(values).some((key) => key.startsWith("ytbt:prepared:"))) {
      snapshotWrites += 1;
      if (snapshotWrites === 1) return "QUOTA_BYTES quota exceeded";
    }
    return null;
  };
  const page = await seedPage(storage, translations, { cues: rawCues(3) });
  assert.equal(snapshotWrites, 2);
  assert.equal(storage.data["ytbt:prepared:oldest"], undefined);
  assert.deepEqual(storage.data["ytbt:prepared:newer"], { updatedAt: 2, cues: [] });
  assert.deepEqual(storage.data["ytbt:translation-sentinel"], { translatedText: "保留翻译" });
  assert.equal(storage.data.deepseekApiKey, "stored-api-key");
  const mutations = storage.operations.filter(({ method }) => method === "set" || method === "remove");
  assert.deepEqual(mutations.map(({ method }) => method), ["set", "remove", "set"]);
  assert.deepEqual(mutations[1].values, ["ytbt:prepared:oldest"]);
  assert.equal(page.calls.paid.flatMap((call) => call.cues).length, 3);
  const refreshed = loadContent(storage, translations);
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.deepEqual(viewCues(refreshed), viewCues(page));
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
});

test("non-quota snapshot write failure is shown and stops before paid translation", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  storage.data["ytbt:prepared:existing"] = { updatedAt: 1, cues: [] };
  storage.failure = (method) => method === "set" ? "Local storage write permission denied" : null;
  const page = loadContent(storage, translations);
  await page.api.handlePlayerResponse(playerResponse("video-1", {}, rawCues(3)));
  await settle(page);
  assert.match(page.api.state.statusText, /Local storage write permission denied/);
  assert.equal(page.api.state.cues.length, 0);
  assert.equal(page.calls.segmentation.length, 1);
  assert.equal(page.calls.cacheOnly.length, 0);
  assert.equal(page.calls.paid.length, 0);
  assert.equal(storage.operations.filter(({ method }) => method === "set").length, 1);
  assert.equal(storage.operations.filter(({ method }) => method === "remove").length, 0);
  assert.deepEqual(storage.data["ytbt:prepared:existing"], { updatedAt: 1, cues: [] });
});
