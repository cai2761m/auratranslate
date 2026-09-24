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

function contentScriptSource() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  const entry = manifest.content_scripts.find((candidate) => (candidate.js || []).includes("src/content-core.js"));
  return entry.js
    .filter((file) => file.startsWith("src/content-"))
    .map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8"))
    .join("\n");
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
              if (options.dispatch) {
                callback(await options.dispatch(saved));
                return;
              }
              if (message.type === "SEGMENT_SUBTITLES") {
                callback({ ok: true, groups: options.segmentationGroups ? options.segmentationGroups(message.cues) : message.cues.map((cue) => ({
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
  let source = contentScriptSource();
  source = source.replace(
    /if \(!IS_DRIVE_PLAYER\) \{\n  bindPageMessages\(\);\n  injectPageBridge\(\);\n\}\ninit\(\);\n?$/,
    "// Tests initialize explicit state in a fresh page context.\n"
  );
  assert.match(source, /Tests initialize explicit state in a fresh page context/);
  source += `
globalThis.__cacheTest = {
  state, prepareCaptionCues, handlePlayerResponse, handleDriveTranscript,
  makeStableTrackFingerprint, resetVideoState, bindStorageChanges, handleSeek,
  scheduleTranslations, makeIncrementalCaptionCues, validPreparedCaptionCache
};
`;
  vm.runInContext(source, context);
  api = context.__cacheTest;
  api.state.settingsLoaded = true;
  api.state.settings = Object.assign({}, Core.DEFAULT_SETTINGS, {
    deepseekApiKey: "test-api-key-must-not-be-in-snapshot",
    subtitleTranslationMode: "full",
    ...options.settings
  });
  return { api, calls, window };
}

async function settle(page) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await nextTurn();
    if (!page.api.state.queue.length && !page.api.state.inFlight.size && !page.api.state.preparationPromise) {
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

test("seeking recovers only undelivered connection failures and preserves paid results", async () => {
  const page = loadContent(sharedStorage(), new Map());
  const cues = [
    { id: "lost", status: "failed", lastError: "Could not establish connection. Receiving end does not exist." },
    { id: "lost-localized", status: "failed", lastError: "扩展后台暂时无法连接，请稍后拖动进度条重试。" },
    { id: "paid", status: "translated", translatedText: "缓存译文" },
    { id: "busy", status: "translating" },
    { id: "auth", status: "failed", lastError: "API Key not configured." },
    { id: "ambiguous", status: "failed", lastError: "The message port closed before a response was received." }
  ].map((cue, index) => ({ sourceText: `Sentence ${index}.`, startMs: index * 1000, endMs: index * 1000 + 900, ...cue }));
  page.api.state.cues = cues;
  page.api.state.video = { currentTime: 50 };
  page.api.handleSeek();
  // Repeated seeks while reconnecting must not duplicate the in-flight batch.
  page.api.handleSeek();
  await settle(page);
  assert.deepEqual(page.calls.paid.flatMap((call) => call.cues.map((cue) => cue.id)), ["lost-localized", "lost"]);
  assert.equal(cues[0].status, "translated");
  assert.equal(cues[1].status, "translated");
  assert.equal(cues[2].translatedText, "缓存译文");
  assert.equal(cues[3].status, "translating");
  assert.equal(cues[4].status, "failed");
  assert.equal(cues[5].status, "failed");
});

test("refresh restores every translated cue without fetching, segmenting, or paid translation", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const first = await seedPage(storage, translations);
  assert.ok(first.calls.segmentation.length > 1);
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

test("saving smaller and larger font scales updates content without retranslating cues", async () => {
  const storage = sharedStorage();
  const page = await seedPage(storage, new Map());
  page.api.bindStorageChanges();
  const before = viewCues(page);
  const paidCount = page.calls.paid.length;
  const segmentationCount = page.calls.segmentation.length;
  for (const scale of [0.3, 0.55, 3]) {
    await new Promise((resolve) => storage.local.set({ fontScale: scale }, resolve));
    await nextTurn();
    assert.equal(page.api.state.settings.fontScale, scale);
    assert.deepEqual(viewCues(page), before);
  }
  assert.equal(page.calls.paid.length, paidCount);
  assert.equal(page.calls.segmentation.length, segmentationCount);
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
      assert.ok(refreshed.calls.segmentation.length > 1);
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
  assert.equal(snapshotWrites, 3);
  assert.equal(storage.data["ytbt:prepared:oldest"], undefined);
  assert.deepEqual(storage.data["ytbt:prepared:newer"], { updatedAt: 2, cues: [] });
  assert.deepEqual(storage.data["ytbt:translation-sentinel"], { translatedText: "保留翻译" });
  assert.equal(storage.data.deepseekApiKey, "stored-api-key");
  const mutations = storage.operations.filter(({ method }) => method === "set" || method === "remove");
  assert.deepEqual(mutations.map(({ method }) => method), ["set", "remove", "set", "set"]);
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
  assert.equal(page.calls.segmentation.length, 0);
  assert.equal(page.calls.cacheOnly.length, 0);
  assert.equal(page.calls.paid.length, 0);
  assert.equal(storage.operations.filter(({ method }) => method === "set").length, 1);
  assert.equal(storage.operations.filter(({ method }) => method === "remove").length, 0);
  assert.deepEqual(storage.data["ytbt:prepared:existing"], { updatedAt: 1, cues: [] });
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("Expected incremental progress did not arrive");
}

async function startIncremental(storage, translations, options = {}) {
  const page = loadContent(storage, translations, {
    ...options, settings: { subtitleTranslationMode: "economy", ...options.settings }
  });
  page.api.state.video = { currentTime: options.currentTime || 0 };
  const cues = options.cues || rawCues(120);
  const payload = playerResponse("video-1", {}, cues);
  const fingerprint = page.api.makeStableTrackFingerprint(payload.videoId, payload.captionTracks[0], null);
  page.api.resetVideoState(payload.videoId, payload.captionTracks[0], fingerprint, null);
  await page.api.prepareCaptionCues(cues, payload.videoId, fingerprint, page.api.state.loadingToken, "Test captions");
  return page;
}

test("first nearby translation renders while a later segmentation window is still blocked", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let segmentationCount = 0;
  const page = await startIncremental(sharedStorage(), new Map(), {
    currentTime: 600,
    async beforeResponse(message) {
      if (message.type === "SEGMENT_SUBTITLES" && ++segmentationCount === 2) await held;
    }
  });
  try {
    await waitUntil(() => segmentationCount === 2 && page.api.state.cues.some((cue) => cue.status === "translated"));
    assert.ok(page.calls.segmentation[0].cues.some((cue) => cue.startMs === 600000));
    assert.ok(page.calls.segmentation[0].cues.length < 120);
    assert.ok(page.api.state.cues.find((cue) => cue.startMs === 600000).translatedText);
    assert.ok(page.api.state.cues.some((cue) => cue.pendingWindow));
  } finally { release(); }
  await settle(page);
});

test("economy mode bounds paid work, advances with playback, and refresh reuses partial progress", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const page = await startIncremental(storage, translations);
  await settle(page);
  assert.equal(Core.DEFAULT_SETTINGS.subtitleTranslationMode, "economy");
  assert.equal(Core.DEFAULT_SETTINGS.subtitleLookAheadMinutes, 2);
  assert.equal(page.calls.paid.flatMap((call) => call.cues).length, 12);
  assert.ok(page.calls.segmentation.flatMap((call) => call.cues).every((cue) => cue.startMs < 120000));
  const paidBefore = page.calls.paid.length;
  const segmentBefore = page.calls.segmentation.length;
  page.api.scheduleTranslations(0, false);
  await settle(page);
  assert.equal(page.calls.paid.length, paidBefore, "remaining idle must not translate the full video");
  assert.equal(page.calls.segmentation.length, segmentBefore);

  page.api.state.video.currentTime = 60;
  page.api.scheduleTranslations(60000, false);
  await settle(page);
  assert.equal(page.calls.paid.flatMap((call) => call.cues).length, 18);
  const refreshed = loadContent(storage, translations, { settings: { subtitleTranslationMode: "economy" } });
  refreshed.api.state.video = { currentTime: 60 };
  await refreshed.api.handlePlayerResponse(playerResponse("video-1", {}, rawCues(120)));
  await settle(refreshed);
  assert.equal(refreshed.calls.fetch.length, 0);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
  assert.deepEqual(viewCues(refreshed), viewCues(page));
});

test("seek reprioritizes remaining segmentation and never translates stale unsent windows", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const page = await startIncremental(sharedStorage(), new Map(), {
    async beforeResponse(message) {
      if (message.type === "SEGMENT_SUBTITLES" && ++count === 1) await held;
    }
  });
  await waitUntil(() => count === 1);
  page.api.state.video.currentTime = 600;
  page.api.handleSeek();
  page.api.handleSeek();
  release();
  await settle(page);
  assert.equal(page.calls.segmentation[1].cues[0].startMs, 600000);
  assert.equal(page.calls.paid.flatMap((call) => call.cues).length, 12);
  assert.ok(page.calls.paid.flatMap((call) => call.cues).every((cue) => /number (6[1-9]|7[0-2])\./.test(cue.sourceText)));
  assert.equal(new Set(page.calls.segmentation.map((call) => call.cues[0].id)).size, page.calls.segmentation.length);
});

test("switching full mode back to economy drops queued distant translations but keeps in-flight results", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let hold = true;
  const page = await startIncremental(sharedStorage(), new Map(), {
    settings: { llmSentenceSegmentationEnabled: false, subtitleTranslationMode: "full" },
    async beforeResponse(message) { if (!message.cacheOnly && hold) await held; }
  });
  assert.equal(page.calls.paid.length, 2);
  assert.ok(page.api.state.queue.length > 0);
  page.api.state.settings.subtitleTranslationMode = "economy";
  page.api.state.video.currentTime = 900;
  page.api.handleSeek();
  hold = false;
  release();
  await settle(page);
  assert.equal(page.calls.paid.length, 3);
  assert.equal(page.calls.paid[2].cues.length, 12);
  assert.ok(page.api.state.cues.slice(0, 60).every((cue) => cue.status === "translated"));
  assert.ok(page.api.state.cues.slice(60, 90).every((cue) => cue.status === "pending"));
});

test("switching modes via settings reuses prepared and translated windows without reloading", async () => {
  const storage = sharedStorage();
  const page = await startIncremental(storage, new Map(), { cues: rawCues(42) });
  await settle(page);
  page.api.bindStorageChanges();
  const firstIds = page.api.state.cues.filter((cue) => cue.status === "translated").map((cue) => cue.id);
  await new Promise((resolve) => storage.local.set({ subtitleTranslationMode: "full" }, resolve));
  await settle(page);
  assert.ok(page.api.state.cues.every((cue) => cue.status === "translated"));
  assert.equal(page.calls.paid.flatMap((call) => call.cues).length, 42);
  assert.ok(firstIds.every((id) => page.api.state.cues.some((cue) => cue.id === id)));
  const paidBefore = page.calls.paid.length;
  await new Promise((resolve) => storage.local.set({ subtitleTranslationMode: "economy", subtitleLookAheadMinutes: 1 }, resolve));
  await settle(page);
  assert.equal(page.calls.paid.length, paidBefore);
});

test("disabling subtitles stops new segmentation and translation after the active window", async () => {
  const storage = sharedStorage();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const page = await startIncremental(storage, new Map(), {
    async beforeResponse(message) { if (message.type === "SEGMENT_SUBTITLES") await held; }
  });
  page.api.bindStorageChanges();
  await waitUntil(() => page.calls.segmentation.length === 1);
  await new Promise((resolve) => storage.local.set({ subtitleEnabled: false }, resolve));
  release();
  await settle(page);
  assert.equal(page.calls.segmentation.length, 1);
  assert.equal(page.calls.paid.length, 0);
  await new Promise((resolve) => storage.local.set({ subtitleEnabled: true }, resolve));
  await settle(page);
  assert.equal(page.calls.paid.flatMap((call) => call.cues).length, 12);
});

test("local segmentation also respects one and three minute lookahead settings", async () => {
  for (const minutes of [1, 3]) {
    const page = await startIncremental(sharedStorage(), new Map(), {
      currentTime: 300,
      settings: { llmSentenceSegmentationEnabled: false, subtitleLookAheadMinutes: minutes }
    });
    await settle(page);
    assert.equal(page.calls.segmentation.length, 0);
    assert.equal(page.calls.paid.flatMap((call) => call.cues).length, minutes * 6);
    assert.ok(page.api.state.cues.filter((cue) => cue.status === "translated")
      .every((cue) => cue.startMs >= 300000 && cue.startMs < 300000 + minutes * 60000));
  }
});

test("merged window cue identities survive refresh, seeks, and mode changes", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const page = await startIncremental(storage, translations, {
    currentTime: 300,
    segmentationGroups: (cues) => [{ startId: cues[0].id, endId: cues.at(-1).id }]
  });
  await settle(page);
  const done = page.api.state.cues.filter((cue) => cue.status === "translated");
  assert.equal(done.length, 4);
  assert.equal(new Set(page.api.state.cues.map((cue) => cue.id)).size, page.api.state.cues.length);
  const refreshed = loadContent(storage, translations, { settings: { subtitleTranslationMode: "economy" } });
  refreshed.api.state.video = { currentTime: 300 };
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
  assert.deepEqual(viewCues(refreshed), viewCues(page));
});

test("legacy complete snapshots remain readable without repaying for segmentation", async () => {
  const storage = sharedStorage();
  const translations = new Map();
  const first = await seedPage(storage, translations, { cues: rawCues(3) });
  const key = Object.keys(storage.data).find((key) => key.startsWith("ytbt:prepared:"));
  storage.data[key].version = 1;
  const refreshed = loadContent(storage, translations, { settings: { subtitleTranslationMode: "economy" } });
  await refreshed.api.handlePlayerResponse(playerResponse());
  await settle(refreshed);
  assert.equal(refreshed.calls.segmentation.length, 0);
  assert.equal(refreshed.calls.paid.length, 0);
  assert.deepEqual(viewCues(refreshed), viewCues(first));
});

test("window boundaries prefer complete sentences and retain every unpunctuated cue", () => {
  const page = loadContent(sharedStorage(), new Map());
  const input = Array.from({ length: 80 }, (_, index) => ({
    id: String(index), startMs: index * 3000, endMs: (index + 1) * 3000,
    sourceText: index === 8 ? "the end." : "a phrase"
  }));
  const windows = page.api.makeIncrementalCaptionCues(input);
  assert.equal(windows.length, input.length);
  assert.equal(windows[8].pendingWindow, windows[0].pendingWindow);
  assert.notEqual(windows[9].pendingWindow, windows[8].pendingWindow);
  const groups = Map.groupBy(windows, (cue) => cue.pendingWindow);
  assert.ok([...groups.values()].every((cues) => cues.length <= 16));
});

test("failure saving a completed window stops new paid work and remains visible", async () => {
  const storage = sharedStorage();
  let writes = 0;
  storage.failure = (method) => method === "set" && ++writes > 1 ? "Storage offline" : null;
  const page = await startIncremental(storage, new Map());
  await settle(page);
  assert.equal(page.calls.segmentation.length, 1);
  assert.equal(page.calls.paid.length, 0);
  assert.match(page.api.state.statusText, /Storage offline/);
  page.api.handleSeek();
  await settle(page);
  assert.equal(page.calls.segmentation.length, 1);
  assert.match(page.api.state.statusText, /Storage offline/);
});

test("a stale segmentation completion cannot overwrite another video", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const page = await startIncremental(sharedStorage(), new Map(), {
    async beforeResponse(message) { if (message.type === "SEGMENT_SUBTITLES") await held; }
  });
  await waitUntil(() => page.calls.segmentation.length === 1);
  const oldWork = page.api.state.preparationPromise;
  page.api.resetVideoState("video-2", null, "track-2");
  release();
  await oldWork;
  assert.equal(page.api.state.videoId, "video-2");
  assert.equal(page.api.state.cues.length, 0);
  assert.equal(page.calls.paid.length, 0);
});

function startBackground(storage, providerCalls) {
  let listener;
  const context = vm.createContext({
    YTBTCore: Core, AbortController, setTimeout, clearTimeout,
    chrome: { storage, runtime: { onMessage: { addListener(value) { listener = value; } } } },
    async fetch(url, options) {
      const payload = JSON.parse(options.body);
      const input = JSON.parse(payload.messages[1].content).items;
      const segmentation = payload.messages[0].content.includes("sentence-boundary engine");
      providerCalls.push({ segmentation, input });
      const content = segmentation
        ? { groups: input.map((cue) => ({ startId: cue.id, endId: cue.id })) }
        : { items: input.map((cue) => ({ id: cue.id, translatedText: `译文：${cue.text}` })) };
      return { ok: true, async text() { return JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }]
      }); } };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8"), context);
  return (message) => new Promise((resolve) => assert.equal(listener(message, {}, resolve), true));
}

test("real content/background pipeline resumes partial windows after worker restart without provider calls", async () => {
  const storage = sharedStorage();
  Object.assign(storage.data, Core.DEFAULT_SETTINGS, { translationApiKey: "fake-key" });
  const providerCalls = [];
  const page = await startIncremental(storage, new Map(), { dispatch: startBackground(storage, providerCalls) });
  await settle(page);
  assert.equal(providerCalls.filter((call) => !call.segmentation).flatMap((call) => call.input).length, 12);
  assert.ok(providerCalls.some((call) => call.segmentation));
  const count = providerCalls.length;
  const refreshed = loadContent(storage, new Map(), {
    dispatch: startBackground(storage, providerCalls), settings: { subtitleTranslationMode: "economy" }
  });
  await refreshed.api.handlePlayerResponse(playerResponse("video-1", {}, rawCues(120)));
  await settle(refreshed);
  assert.equal(providerCalls.length, count);
  assert.deepEqual(viewCues(refreshed), viewCues(page));
  refreshed.api.state.video = { currentTime: 600 };
  refreshed.api.handleSeek();
  await settle(refreshed);
  assert.equal(providerCalls.filter((call) => !call.segmentation).flatMap((call) => call.input).length, 24);
  const afterSeek = providerCalls.length;
  refreshed.api.state.video.currentTime = 0;
  refreshed.api.handleSeek();
  await settle(refreshed);
  assert.equal(providerCalls.length, afterSeek);
});
