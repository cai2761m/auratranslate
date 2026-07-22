const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");

test("background segments subtitles before translation and reuses its cache", async () => {
  const storage = Object.assign({}, Core.DEFAULT_SETTINGS, {
    translationProvider: "custom",
    translationApiKey: "test-key",
    translationBaseUrl: "https://api.example.com/v1",
    translationModel: "test-model",
    llmSentenceSegmentationEnabled: true
  });
  let fetchCount = 0;
  const chrome = {
    runtime: {
      onMessage: {
        addListener() {}
      }
    },
    storage: {
      local: {
        get(defaults, callback) {
          if (defaults == null) {
            callback(Object.assign({}, storage));
            return;
          }
          callback(Object.assign({}, defaults, storage));
        },
        set(values, callback) {
          Object.assign(storage, values);
          if (callback) {
            callback();
          }
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storage[key];
          }
          if (callback) {
            callback();
          }
        }
      }
    }
  };
  const context = vm.createContext({
    AbortController,
    chrome,
    console,
    fetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    groups: [
                      {
                        startId: "0",
                        endId: "0",
                        displaySourceText: "Multiplicative constants do not help."
                      },
                      {
                        startId: "1",
                        endId: "2",
                        displaySourceText: "For example, if n doubles, then 8n will also double."
                      }
                    ]
                  })
                },
                finish_reason: "stop"
              }
            ]
          });
        }
      };
    },
    importScripts() {},
    setTimeout,
    clearTimeout,
    YTBTCore: Core
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
  vm.runInContext(source, context);

  const message = {
    type: "SEGMENT_SUBTITLES",
    videoId: "video-1",
    trackFingerprint: "track-1",
    cues: [
      {
        id: "0",
        startMs: 0,
        endMs: 3000,
        sourceText: "Multiplicative constants do not help."
      },
      { id: "1", startMs: 3000, endMs: 4500, sourceText: "For example, if n" },
      {
        id: "2",
        startMs: 4500,
        endMs: 7000,
        sourceText: "doubles, then 8n will also double."
      }
    ]
  };
  context.testMessage = message;
  const first = await vm.runInContext("handleSegmentSubtitles(testMessage)", context);
  const second = await vm.runInContext("handleSegmentSubtitles(testMessage)", context);

  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(first.groups.map((group) => [group.startId, group.endId]))),
    [["0", "0"], ["1", "2"]]
  );
  assert.equal(second.cached, true);
  assert.equal(fetchCount, 1);
  assert.ok(Object.keys(storage).some((key) => key.startsWith("ytbt:segments:")));
});
