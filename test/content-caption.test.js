const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");

function loadCaptionApi(fetchImpl) {
  const rootClasses = new Set();
  const document = {
    documentElement: {
      classList: {
        toggle(name, enabled) {
          if (enabled) rootClasses.add(name);
          else rootClasses.delete(name);
        }
      }
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    location: {
      hostname: "www.youtube.com",
      origin: "https://www.youtube.com",
      pathname: "/watch",
      href: "https://www.youtube.com/watch?v=video-1"
    },
    postMessage() {}
  };
  const context = vm.createContext({
    AbortController,
    Node: { ELEMENT_NODE: 1 },
    URL,
    YTBTCore: Core,
    btoa,
    clearTimeout,
    chrome: {
      runtime: {
        sendMessage(message, callback) { callback({ ok: true, items: [] }); }
      },
      storage: {
        local: {
          get(defaults, callback) { callback(defaults || {}); },
          set(values, callback) { callback(); },
          remove(keys, callback) { callback(); }
        }
      }
    },
    document,
    fetch: fetchImpl,
    requestAnimationFrame() {},
    setTimeout,
    window
  });

  let source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  source = source.replace(
    /\r?\n  if \(!IS_DRIVE_PLAYER\) \{\r?\n    bindPageMessages\(\);\r?\n    injectPageBridge\(\);\r?\n  \}\r?\n  init\(\);/,
    "\n  // Initialization is omitted by these isolated caption tests."
  );
  source = source.replace(
    /\n\}\)\(\);\s*$/,
    [
      "",
      "  globalThis.__YTBTCaptionTest = {",
      "    state,",
      "    handlePlayerResponse,",
      "    fetchCaptionTrack,",
      "    fetchTranscriptPanelTrack,",
      "    transcriptPanelParams,",
      "    parseCapturedCaptionText,",
      "    applySettings",
      "  };",
      "})();"
    ].join("\n")
  );
  vm.runInContext(source, context);
  return { api: context.__YTBTCaptionTest, rootClasses };
}

function transcriptPanelFixture() {
  return {
    content: {
      timelineItemViewModel: {
        startTimeSeconds: 1,
        contentItems: [
          {
            transcriptSegmentViewModel: {
              simpleText: "Hello world.",
              timestamp: "0:01"
            }
          }
        ]
      }
    }
  };
}

test("modern transcript panel uses the video params and parses its response", async () => {
  const calls = [];
  const { api } = loadCaptionApi(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(transcriptPanelFixture());
      }
    };
  });

  const cues = await api.fetchTranscriptPanelTrack("dQw4w9WgXcQ", {
    clientVersion: "2.20260826.01.00",
    context: { client: { hl: "en", gl: "US" } }
  });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/youtubei/v1/get_panel");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.panelId, "PAmodern_transcript_view");
  assert.equal(body.params, "qgkPCgtkUXc0dzlXZ1hjURgB");
  assert.equal(body.context.client.clientVersion, "2.20260826.01.00");
  assert.deepEqual(cues, [
    { startMs: 1000, endMs: 6000, sourceText: "Hello world." }
  ]);
});

test("timedtext rate limiting stops after the first request", async () => {
  let requests = 0;
  const { api } = loadCaptionApi(async () => {
    requests += 1;
    return {
      ok: false,
      status: 429,
      async text() {
        return "rate limited";
      }
    };
  });

  await assert.rejects(
    api.fetchCaptionTrack({
      baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=en",
      languageCode: "en"
    }, "video-1"),
    /429/
  );
  assert.equal(requests, 1);
});

test("identical player responses share one in-flight caption load", async () => {
  let finishFetch;
  let requests = 0;
  const responsePromise = new Promise((resolve) => {
    finishFetch = resolve;
  });
  const { api } = loadCaptionApi(async () => {
    requests += 1;
    return responsePromise;
  });
  api.state.settingsLoaded = true;
  api.state.settings = Object.assign({}, Core.DEFAULT_SETTINGS, {
    subtitleEnabled: true,
    sourceLanguage: "en"
  });
  const payload = {
    videoId: "video-1",
    captionTracks: [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=en",
        languageCode: "en",
        kind: "asr",
        vssId: "a.en",
        name: "English"
      }
    ],
    transcript: {
      clientVersion: "2.20260826.01.00",
      context: { client: { hl: "en", gl: "US" } }
    }
  };

  const first = api.handlePlayerResponse(payload);
  const second = api.handlePlayerResponse(payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);

  finishFetch({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(transcriptPanelFixture());
    }
  });
  await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(api.state.cues.length, 1);
});

test("native caption controls stay available until custom cues are ready", () => {
  const { api, rootClasses } = loadCaptionApi(async () => {
    throw new Error("unexpected fetch");
  });
  api.state.settings = Object.assign({}, Core.DEFAULT_SETTINGS, {
    subtitleEnabled: true
  });

  api.state.cues = [];
  api.applySettings();
  assert.equal(rootClasses.has("ytbt-hide-native-captions"), false);

  api.state.cues = [{ startMs: 0, endMs: 1000, sourceText: "Ready" }];
  api.applySettings();
  assert.equal(rootClasses.has("ytbt-hide-native-captions"), true);
});
