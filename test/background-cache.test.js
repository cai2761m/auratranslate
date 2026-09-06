const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");
const backgroundSource = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFixture(settings = {}) {
  const fixture = {
    storage: {
      ...Core.DEFAULT_SETTINGS,
      translationProvider: "custom",
      translationApiKey: "test-key",
      translationBaseUrl: "https://api.example.com/v1",
      translationModel: "test-model",
      ...settings
    },
    fetchCount: 0,
    hooks: {}
  };
  fixture.startWorker = () => {
    let listener;
    const runtime = {
      onMessage: { addListener(value) { listener = value; } }
    };
    function finish(callback, value, error) {
      if (error) runtime.lastError = { message: error };
      try { callback(value); }
      finally { delete runtime.lastError; }
    }
    const chrome = {
      runtime,
      storage: {
        local: {
          get(defaults, callback) {
            const values = defaults == null
              ? fixture.storage
              : Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
                key, Object.hasOwn(fixture.storage, key) ? fixture.storage[key] : fallback
              ]));
            const snapshot = structuredClone(values);
            queueMicrotask(() => finish(callback, snapshot, fixture.hooks.getError));
          },
          set(values, callback) {
            const commit = () => {
              const error = fixture.hooks.setError;
              if (!error) Object.assign(fixture.storage, structuredClone(values));
              finish(callback, undefined, error);
            };
            if (fixture.hooks.beforeSet) fixture.hooks.beforeSet(commit);
            else queueMicrotask(commit);
          },
          remove(keys, callback) {
            queueMicrotask(() => {
              const error = fixture.hooks.removeError;
              if (!error) {
                for (const key of Array.isArray(keys) ? keys : [keys]) delete fixture.storage[key];
              }
              finish(callback, undefined, error);
            });
          }
        }
      }
    };
    const context = vm.createContext({
      AbortController,
      chrome,
      console,
      setTimeout,
      clearTimeout,
      importScripts() {},
      YTBTCore: Core,
      async fetch(url, options) {
        fixture.fetchCount += 1;
        const payload = JSON.parse(options.body);
        const input = JSON.parse(payload.messages[1].content);
        const content = payload.messages[0].content.includes("sentence-boundary engine")
          ? { groups: input.items.map((item) => ({ startId: item.id, endId: item.id })) }
          : {
            items: input.items.map((item) => ({
              id: item.id,
              translatedText: `Translated: ${item.text}`
            }))
          };
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify(content)
                },
                finish_reason: "stop"
              }]
            });
          }
        };
      }
    });
    vm.runInContext(backgroundSource, context);
    return {
      request(message) {
        return new Promise((resolve) => {
          assert.equal(listener(message, {}, resolve), true);
        });
      }
    };
  };
  return fixture;
}

function translationMessage(ids, extra = {}) {
  return {
    type: "TRANSLATE_BATCH",
    videoId: "video-1",
    trackFingerprint: "track-1",
    cues: ids.map((id) => ({ id, sourceText: `Source ${id}` })),
    ...extra
  };
}

function translationCaches(fixture) {
  return Object.entries(fixture.storage).filter(([key, value]) => key.startsWith("ytbt:") && value.items);
}

test("parallel subtitle batches all survive refresh and service-worker restart", async () => {
  const fixture = createFixture();
  let worker = fixture.startWorker();
  const ids = Array.from({ length: 8 }, (_, index) => String(index));
  const responses = await Promise.all(ids.map((id) => worker.request(translationMessage([id]))));

  assert.ok(responses.every((response) => response.ok));
  assert.equal(fixture.fetchCount, 8);
  assert.deepEqual(Object.keys(translationCaches(fixture)[0][1].items).sort(), ids);

  worker = fixture.startWorker();
  const refreshed = await worker.request(translationMessage(ids));
  assert.equal(refreshed.items.length, 8);
  assert.ok(refreshed.items.every((item) => item.cached));
  assert.equal(fixture.fetchCount, 8, "refresh must not pay for completed batches again");
});

test("refresh shares a paid batch until its storage write completes", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  fixture.hooks.beforeSet = (commit) => {
    writeStarted.resolve();
    releaseWrite.promise.then(commit);
  };
  const first = worker.request(translationMessage(["0"]));
  await writeStarted.promise;
  const refreshed = worker.request(translationMessage(["0"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.fetchCount, 1);

  releaseWrite.resolve();
  assert.ok((await first).ok);
  assert.ok((await refreshed).ok);
  assert.equal(fixture.fetchCount, 1);
  assert.equal(Object.keys(translationCaches(fixture)[0][1].items).length, 1);
});

test("cache-only hydration returns partial hits without an API key or paid request", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  await worker.request(translationMessage(["0"]));
  fixture.storage.translationApiKey = "";

  const restarted = fixture.startWorker();
  const response = await restarted.request(translationMessage(["0", "1"], { cacheOnly: true }));
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.items, (item) => item.id), ["0"]);
  assert.equal(response.items[0].cached, true);
  const hit = await restarted.request(translationMessage(["0"]));
  assert.equal(hit.ok, true);
  const miss = await restarted.request(translationMessage(["1"], { cacheOnly: true }));
  assert.equal(miss.ok, true);
  assert.equal(miss.items.length, 0);
  assert.equal(fixture.fetchCount, 1);
});

test("refresh shares sentence segmentation until its cache has been saved", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  fixture.hooks.beforeSet = (commit) => {
    writeStarted.resolve();
    releaseWrite.promise.then(commit);
  };
  const message = translationMessage([], {
    type: "SEGMENT_SUBTITLES",
    cues: [{ id: "0", sourceText: "A complete sentence.", startMs: 0, endMs: 2000 }]
  });
  const first = worker.request(message);
  await writeStarted.promise;
  const refreshed = worker.request(message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.fetchCount, 1);
  releaseWrite.resolve();
  assert.ok((await first).ok);
  assert.ok((await refreshed).ok);
  assert.equal((await fixture.startWorker().request(message)).cached, true);
  assert.equal(fixture.fetchCount, 1);
});

test("storage write errors are visible and retrying reuses the already paid result", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  fixture.hooks.setError = "QUOTA_BYTES quota exceeded";
  const failed = await worker.request(translationMessage(["0"]));
  assert.equal(failed.ok, false);
  assert.match(failed.errors[0].message, /Unable to save subtitle cache.*quota exceeded/);
  assert.equal(translationCaches(fixture).length, 0);
  assert.equal(fixture.fetchCount, 1);

  delete fixture.hooks.setError;
  const recovered = await worker.request(translationMessage(["0"]));
  assert.equal(recovered.ok, true);
  assert.equal(fixture.fetchCount, 1);
  const restarted = fixture.startWorker();
  assert.equal((await restarted.request(translationMessage(["0"]))).items[0].cached, true);
  assert.equal(fixture.fetchCount, 1);
});

test("all new cached translations validate their source even with segmentation disabled", async () => {
  const fixture = createFixture({ llmSentenceSegmentationEnabled: false });
  await fixture.startWorker().request(translationMessage(["0"]));
  const changed = translationMessage([], {
    cues: [{ id: "0", sourceText: "A changed subtitle" }]
  });
  const restarted = fixture.startWorker();
  const hydration = await restarted.request({ ...changed, cacheOnly: true });
  assert.equal(hydration.items.length, 0);
  const translated = await restarted.request(changed);
  assert.equal(translated.items[0].translatedText, "Translated: A changed subtitle");
  assert.equal(fixture.fetchCount, 2);
});

test("legacy un-fingerprinted entries remain readable only without segmentation", async () => {
  for (const segmented of [false, true]) {
    const fixture = createFixture({ llmSentenceSegmentationEnabled: segmented });
    await fixture.startWorker().request(translationMessage(["0"]));
    translationCaches(fixture)[0][1].items["0"] = "Legacy translation";
    const response = await fixture.startWorker().request(translationMessage(["0"], { cacheOnly: true }));
    assert.equal(response.items.length, segmented ? 0 : 1);
    assert.equal(fixture.fetchCount, 1);
  }
});

test("concurrent video cache writes enforce the shared cache limit", async () => {
  const fixture = createFixture({ translationCacheMaxItems: 2 });
  const worker = fixture.startWorker();
  const responses = await Promise.all(["a", "b", "c"].map((videoId) => (
    worker.request(translationMessage(["0"], { videoId }))
  )));
  assert.ok(responses.every((response) => response.ok));
  assert.equal(translationCaches(fixture).reduce((sum, [, entry]) => sum + Object.keys(entry.items).length, 0), 2);
});

test("storage read and eviction failures are surfaced and do not poison later writes", async () => {
  const fixture = createFixture({ translationCacheMaxItems: 1 });
  const worker = fixture.startWorker();
  fixture.hooks.getError = "Storage unavailable";
  const failedRead = await worker.request(translationMessage(["0"]));
  assert.equal(failedRead.ok, false);
  assert.match(failedRead.errors[0].message, /Unable to read subtitle cache/);
  assert.equal(fixture.fetchCount, 0);
  delete fixture.hooks.getError;
  await worker.request(translationMessage(["0"]));

  fixture.hooks.removeError = "Storage unavailable";
  const failedEviction = await worker.request(translationMessage(["0"], { videoId: "video-2" }));
  assert.equal(failedEviction.ok, false);
  assert.match(failedEviction.errors[0].message, /Unable to remove subtitle cache/);
  assert.equal(fixture.fetchCount, 2);
  delete fixture.hooks.removeError;
  assert.equal((await worker.request(translationMessage(["0"], { videoId: "video-2" }))).ok, true);
  assert.equal(fixture.fetchCount, 2);
  assert.equal(translationCaches(fixture).length, 1);
});
