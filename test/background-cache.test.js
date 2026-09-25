const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const Core = require("../src/shared.js");

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
    inputs: [],
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
      crypto: require("node:crypto").webcrypto,
      TextEncoder,
      chrome,
      console,
      setTimeout,
      clearTimeout,

      YTBTCore: Core,
      async fetch(url, options) {
        fixture.fetchCount += 1;
        if (fixture.hooks.fetch) {
          const response = await fixture.hooks.fetch(url, options);
          if (response) return response;
        }
        const payload = JSON.parse(options.body);
        const input = JSON.parse(payload.messages[1].content);
        fixture.inputs.push(input.items);
        if (fixture.hooks.beforeFetch) await fixture.hooks.beforeFetch(input);
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
    require("../scripts/extension-scripts.cjs").loadBackground(context);
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

function immersiveMessage(texts, extra = {}) {
  return {
    type: "IMMERSIVE_TRANSLATE",
    pageUrl: "https://docs.example.com/guide#intro",
    items: texts.map((sourceText, index) => ({ id: `im${index}`, sourceText })),
    ...extra
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status === 200, status, async text() { return JSON.stringify(body); } };
}

function freeGoogleResponse(text = "谷歌译文") {
  return jsonResponse([[[text, "source", null, null]], null, "en"]);
}

test("legacy Google automatic fallback setting is ignored for AI and subtitle translations", async () => {
  const fixture = createFixture({ immersiveFallbackProvider: "google-free" });
  const urls = [];
  fixture.hooks.fetch = (url) => {
    urls.push(url);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ items: [{ id: "0", translatedText: "AI 译文" }] }) } }] });
  };
  const worker = fixture.startWorker();
  assert.equal((await worker.request(immersiveMessage(["Paragraph"], { cacheOnly: true }))).items.length, 0);
  assert.equal(urls.length, 0);
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).items.length, 1);
  assert.equal((await worker.request(translationMessage(["0"]))).ok, true);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url === "https://api.example.com/v1/chat/completions"));
});

test("direct Google translation works without an AI key and reuses its cache", async () => {
  const fixture = createFixture({ translationApiKey: "", immersiveTranslationService: "google-free" });
  fixture.hooks.fetch = (url, options) => {
    assert.match(url, /^https:\/\/translate.googleapis.com\/translate_a\/single\?/);
    assert.equal(new URL(url).searchParams.get("q"), "Paragraph");
    assert.equal(new URL(url).searchParams.get("sl"), "auto");
    assert.equal(new URL(url).searchParams.get("tl"), "zh-CN");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined, "never forward AI or Cloud keys to the free endpoint");
    return freeGoogleResponse();
  };
  const first = await fixture.startWorker().request(immersiveMessage(["Paragraph", "Paragraph"]));
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].translatedText, "谷歌译文");
  assert.equal(fixture.fetchCount, 1);
  const cached = await fixture.startWorker().request(immersiveMessage(["Paragraph"], { cacheOnly: true }));
  assert.equal(cached.items[0].translatedText, "谷歌译文");
  assert.equal(fixture.fetchCount, 1);
});

test("failed AI is not retried through a saved Google automatic fallback", async () => {
  const fixture = createFixture({ immersiveFallbackProvider: "google-free" });
  const urls = [];
  fixture.hooks.fetch = (url) => { urls.push(url); return jsonResponse({ error: { message: "invalid API key" } }, 401); };
  const result = await fixture.startWorker().request(immersiveMessage(["Paragraph"]));
  assert.equal(result.ok, false);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("api.example.com"));
});

test("free Google translates the FittedBox paragraph in one request and preserves reordered markers", async () => {
  const fixture = createFixture({ immersiveTranslationService: "google-free" });
  const formattedText = "But what happens if you put the [[YTBT_CODE_0]]FittedBox[[/YTBT_CODE_0]] inside of a [[YTBT_CODE_1]]Center[[/YTBT_CODE_1]] widget? The [[YTBT_CODE_2]]Center[[/YTBT_CODE_2]] lets the [[YTBT_CODE_3]]FittedBox[[/YTBT_CODE_3]] be any size it wants, up to the screen size.";
  const translatedText = "但是，如果在 [[YTBT_CODE_1]]Center[[/YTBT_CODE_1]] 组件中放入 [[YTBT_CODE_0]]FittedBox[[/YTBT_CODE_0]]，会发生什么？[[YTBT_CODE_2]]Center[[/YTBT_CODE_2]] 允许 [[YTBT_CODE_3]]FittedBox[[/YTBT_CODE_3]] 自由选择大小，但不能超过屏幕尺寸。";
  const message = immersiveMessage([], { items: [{ id: "im0", sourceText: formattedText.replace(/\[\[\/?YTBT_[A-Z]+_\d+\]\]/g, ""), formattedText }] });
  fixture.hooks.fetch = (url) => {
    assert.equal(new URL(url).searchParams.get("q"), formattedText);
    return freeGoogleResponse(translatedText);
  };
  const response = await fixture.startWorker().request(message);
  assert.equal(response.ok, true);
  assert.equal(response.items[0].translatedText, translatedText);
  assert.equal(response.items[0].translationProvider, "google-free");
  const cached = await fixture.startWorker().request({ ...message, cacheOnly: true });
  assert.equal(cached.items[0].translatedText, translatedText);
  assert.equal(cached.items[0].translationProvider, "google-free");
  assert.equal(fixture.fetchCount, 1);
});

test("page-to-worker Google translation renders whole sentences and restores code and links", async (t) => {
  const { JSDOM } = require("jsdom");
  const fixture = createFixture({ immersiveTranslationService: "google-free" });
  const worker = fixture.startWorker();
  const html = '<main><p>But what happens if you put the <code>FittedBox</code> inside of a <code>Center</code> widget? Read <a href="/guide"><strong>the guide</strong></a>.</p></main>';
  fixture.hooks.fetch = (url) => {
    const text = new URL(url).searchParams.get("q");
    assert.equal(text, "But what happens if you put the [[YTBT_CODE_0]]FittedBox[[/YTBT_CODE_0]] inside of a [[YTBT_CODE_1]]Center[[/YTBT_CODE_1]] widget? Read [[YTBT_A_2]][[YTBT_STRONG_3]]the guide[[/YTBT_STRONG_3]][[/YTBT_A_2]].");
    return freeGoogleResponse("如果在 [[YTBT_CODE_1]]Center[[/YTBT_CODE_1]] 中放入 [[YTBT_CODE_0]]FittedBox[[/YTBT_CODE_0]]，会怎样？阅读[[YTBT_A_2]][[YTBT_STRONG_3]]指南[[/YTBT_STRONG_3]][[/YTBT_A_2]]。");
  };
  for (let load = 0; load < 2; load++) {
    const dom = new JSDOM(html, { url: "https://docs.example.com/guide", runScripts: "outside-only", pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const { window } = dom;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 400, height: 30, top: 0, bottom: 30 });
    const computedStyle = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element) => {
      const style = computedStyle(element);
      return { display: style.display, visibility: style.visibility, opacity: style.opacity || "1", getPropertyValue: style.getPropertyValue.bind(style) };
    };
    window.chrome = { runtime: {}, storage: { local: {
      get: (defaults, done) => done({ ...defaults, ...fixture.storage }), set: (_, done) => done()
    } } };
    window.eval(require("../scripts/extension-scripts.cjs").source("shared"));
    window.YTBTCore = { ...window.YTBTCore, sendRuntimeMessage: (_, message) => worker.request(message) };
    window.eval(require("../scripts/extension-scripts.cjs").source("immersive"));
    const ball = window.document.querySelector(".ytbt-immersive-tab");
    ball.click();
    for (let turn = 0; turn < 100 && ball.dataset.ytbtState === "translating"; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ball.dataset.ytbtState, "done");
    const result = window.document.querySelector(".ytbt-immersive-text");
    assert.equal(result.textContent, "如果在 Center 中放入 FittedBox，会怎样？阅读指南。");
    assert.deepEqual(Array.from(result.querySelectorAll("code"), (node) => node.textContent), ["Center", "FittedBox"]);
    assert.equal(result.querySelector("a").getAttribute("href"), "/guide");
    assert.equal(result.querySelector("a strong").textContent, "指南");
    dom.window.close();
  }
  assert.equal(fixture.fetchCount, 1, "reloading the page uses the corrected cache with no provider call");
});

test("Google preserves nested links, emphasis, breaks and literal code without fragment requests", async () => {
  const fixture = createFixture({ immersiveTranslationService: "google-free" });
  const formattedText = "Read [[YTBT_A_0]][[YTBT_STRONG_1]]the guide[[/YTBT_STRONG_1]][[/YTBT_A_0]][[YTBT_BR_2]][[/YTBT_BR_2]]then [[YTBT_KBD_3]]Enter[[/YTBT_KBD_3]] shows [[YTBT_SAMP_4]]ready[[/YTBT_SAMP_4]].";
  const translated = formattedText.replace("the guide", "指南").replace("Enter", "回车").replace("ready", "就绪");
  fixture.hooks.fetch = (url) => {
    assert.equal(new URL(url).searchParams.get("q"), formattedText);
    return freeGoogleResponse(translated);
  };
  const response = await fixture.startWorker().request(immersiveMessage([], { items: [{ id: "im0", sourceText: "Read the guide then Enter shows ready.", formattedText }] }));
  assert.equal(response.ok, true);
  assert.equal(response.items[0].translatedText, formattedText.replace("the guide", "指南"));
  assert.equal(fixture.fetchCount, 1);
});

test("Google rejects missing, duplicated, unknown or misnested markers without retrying or caching", async (t) => {
  const formattedText = "Read [[YTBT_A_0]][[YTBT_EM_1]]the guide[[/YTBT_EM_1]][[/YTBT_A_0]].";
  const invalid = [
    "阅读指南。",
    formattedText + "[[YTBT_EM_1]]again[[/YTBT_EM_1]]",
    formattedText.replaceAll("EM_1", "EM_9"),
    "[[YTBT_EM_1]][[YTBT_A_0]]指南[[/YTBT_EM_1]][[/YTBT_A_0]]",
    "[[YTBT_A_0]]指南[[/YTBT_A_0]][[YTBT_EM_1]]指南[[/YTBT_EM_1]]"
  ];
  for (const translatedText of invalid) {
    await t.test(translatedText, async () => {
      const fixture = createFixture({ immersiveTranslationService: "google-free" });
      fixture.hooks.fetch = () => freeGoogleResponse(translatedText);
      const worker = fixture.startWorker();
      const message = immersiveMessage([], { items: [{ id: "im0", sourceText: "Read the guide.", formattedText }] });
      const response = await worker.request(message);
      assert.equal(response.ok, false);
      assert.match(response.errors[0].message, /格式标记/);
      assert.equal((await worker.request({ ...message, cacheOnly: true })).items.length, 0);
      assert.equal(fixture.fetchCount, 1);
      assert.equal(translationCaches(fixture).length, 0);
    });
  }
});

test("only obsolete formatted Google cache entries are replaced; AI and plain caches survive", async () => {
  const fixture = createFixture({ translationApiKey: "", immersiveTranslationService: "google-free" });
  const message = immersiveMessage([], { items: [
    { id: "im0", sourceText: "Use FittedBox inside Center.", formattedText: "Use [[YTBT_CODE_0]]FittedBox[[/YTBT_CODE_0]] inside [[YTBT_CODE_1]]Center[[/YTBT_CODE_1]]." },
    { id: "im1", sourceText: "An ordinary paragraph." },
    { id: "im2", sourceText: "Read the guide.", formattedText: "Read [[YTBT_A_0]]the guide[[/YTBT_A_0]]." }
  ] });
  fixture.hooks.fetch = (url) => freeGoogleResponse(new URL(url).searchParams.get("q"));
  assert.equal((await fixture.startWorker().request(message)).items.length, 3);
  const entries = Object.values(translationCaches(fixture)[0][1].items);
  for (const entry of entries) delete entry.googleTranslationVersion;
  entries.find((entry) => entry.sourceText.startsWith("Read")).translationProvider = "custom";
  const restarted = fixture.startWorker();
  const probe = await restarted.request({ ...message, cacheOnly: true });
  assert.deepEqual(Array.from(probe.items, (item) => item.id), ["im1", "im2"]);
  assert.equal(fixture.fetchCount, 3, "cache probes never start replacement requests");
  fixture.hooks.fetch = (url) => {
    assert.equal(new URL(url).searchParams.get("q"), message.items[0].formattedText);
    return freeGoogleResponse(message.items[0].formattedText);
  };
  assert.equal((await restarted.request(message)).items.length, 3);
  assert.equal((await fixture.startWorker().request({ ...message, cacheOnly: true })).items.length, 3);
  assert.equal(fixture.fetchCount, 4);
});

test("obsolete plain-key Google entries cannot bypass formatted cache migration", async () => {
  const fixture = createFixture({ immersiveTranslationService: "google-free" });
  fixture.hooks.fetch = () => freeGoogleResponse("旧译文");
  await fixture.startWorker().request(immersiveMessage(["Use FittedBox."]));
  for (const entry of Object.values(translationCaches(fixture)[0][1].items)) delete entry.googleTranslationVersion;
  const response = await fixture.startWorker().request(immersiveMessage([], { cacheOnly: true, items: [
    { id: "im0", sourceText: "Use FittedBox.", formattedText: "Use [[YTBT_CODE_0]]FittedBox[[/YTBT_CODE_0]]." }
  ] }));
  assert.equal(response.items.length, 0);
  assert.equal(fixture.fetchCount, 1);
});

test("long Google paragraphs split at sentence boundaries without breaking formatting or losing whitespace", async () => {
  const fixture = createFixture({ immersiveTranslationService: "google-free" });
  const sentence = "Read [[YTBT_A_0]]the guide[[/YTBT_A_0]]. ";
  const formattedText = sentence + "word ".repeat(900) + "[[YTBT_CODE_1]]foo<T>() 😀[[/YTBT_CODE_1]].";
  const requests = [];
  fixture.hooks.fetch = (url) => {
    const q = new URL(url).searchParams.get("q");
    requests.push(q);
    assert.ok(Array.from(q).length <= 4000);
    return freeGoogleResponse(q);
  };
  const result = await fixture.startWorker().request(immersiveMessage([], { items: [{ id: "im0", sourceText: "Long paragraph", formattedText }] }));
  assert.equal(result.ok, true);
  assert.equal(requests[0], sentence.trim());
  assert.equal(result.items[0].translatedText, formattedText);
});

test("Google rate limits cool down without retries and earlier successes remain cached", async () => {
  const fixture = createFixture({ translationApiKey: "", immersiveTranslationService: "google-free" });
  let calls = 0;
  fixture.hooks.fetch = () => ++calls === 1 ? freeGoogleResponse() : jsonResponse({}, 429);
  const worker = fixture.startWorker();
  const response = await worker.request(immersiveMessage(["First", "Second", "Third"]));
  assert.equal(response.ok, true);
  assert.equal(response.items.length, 1);
  const retry = await worker.request(immersiveMessage(["Second"]));
  assert.equal(retry.ok, false);
  assert.match(retry.errors[0].message, /冷却/);
  assert.equal(calls, 2);
  assert.equal((await fixture.startWorker().request(immersiveMessage(["First"], { cacheOnly: true }))).items.length, 1);
  assert.equal(calls, 2);
});

test("malformed Google responses surface errors without retrying", async () => {
  const invalid = createFixture({ translationApiKey: "", immersiveTranslationService: "google-free" });
  invalid.hooks.fetch = () => jsonResponse({ unexpected: true });
  assert.equal((await invalid.startWorker().request(immersiveMessage(["Paragraph"]))).ok, false);
  assert.equal(invalid.fetchCount, 1);
});

test("Google storage failures retain results in memory without another request", async () => {
  const fixture = createFixture({ translationApiKey: "", immersiveTranslationService: "google-free" });
  fixture.hooks.fetch = () => freeGoogleResponse("译文");
  fixture.hooks.setError = "Disk full";
  const worker = fixture.startWorker();
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).ok, false);
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).ok, false);
  const cached = await worker.request(immersiveMessage(["Paragraph"], { cacheOnly: true }));
  assert.equal(cached.items[0].translatedText, "译文");
  delete fixture.hooks.setError;
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).ok, true);
  assert.equal(fixture.fetchCount, 1);
});

test("free Google bounds long Unicode input and global concurrency", async () => {
  const fixture = createFixture({ translationApiKey: "", immersiveTranslationService: "google-free" });
  let active = 0;
  let peak = 0;
  fixture.hooks.fetch = async (url) => {
    active++;
    peak = Math.max(peak, active);
    const text = new URL(url).searchParams.get("q");
    assert.ok(Array.from(text).length <= 4000);
    assert.ok(!/[\ud800-\udfff]/u.test(text), "no isolated surrogate halves");
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return freeGoogleResponse(text);
  };
  const worker = fixture.startWorker();
  const results = await Promise.all(["A", "B", "C", "D"].map((prefix) => worker.request(immersiveMessage([prefix + "😀".repeat(4500)]))));
  assert.ok(results.every((response) => response.ok && response.items.length === 1));
  assert.equal(peak, 2);
  assert.equal(fixture.fetchCount, 8);
});

test("immersive cache survives refresh, worker restart, reordering and duplicate headings", async () => {
  const fixture = createFixture();
  const first = await fixture.startWorker().request(immersiveMessage(["Introduction", "Install the editor", "Introduction"]));
  assert.equal(first.items.length, 3);
  assert.equal(fixture.inputs[0].length, 2, "duplicate source text should be billed only once");
  assert.deepEqual(fixture.inputs[0].map((item) => item.id), ["0", "1"], "model gets short IDs");
  const restarted = fixture.startWorker();
  const hit = await restarted.request(immersiveMessage(["Install the editor", "Introduction"], {
    pageUrl: "https://docs.example.com/guide#other", cacheOnly: true
  }));
  assert.equal(hit.ok, true);
  assert.deepEqual(Array.from(hit.items, (item) => [item.id, item.translatedText]), [
    ["im0", "Translated: Install the editor"], ["im1", "Translated: Introduction"]
  ]);
  assert.ok(hit.items.every((item) => item.cached));
  assert.equal(fixture.fetchCount, 1);
});

test("immersive partial hydration never calls provider and only missing text is translated", async () => {
  const fixture = createFixture();
  await fixture.startWorker().request(immersiveMessage(["Existing paragraph"]));
  fixture.storage.translationApiKey = "";
  const worker = fixture.startWorker();
  const message = immersiveMessage(["Existing paragraph", "New paragraph"]);
  const cached = await worker.request({ ...message, cacheOnly: true });
  assert.equal(cached.ok, true);
  assert.equal(cached.items.length, 1);
  assert.equal((await worker.request(immersiveMessage(["Existing paragraph"]))).ok, true);
  assert.equal(fixture.fetchCount, 1);
  fixture.storage.translationApiKey = "rotated-key";
  const translated = await worker.request(message);
  assert.equal(translated.items.length, 2);
  assert.equal(fixture.fetchCount, 2);
  assert.deepEqual(fixture.inputs[1].map((item) => item.text), ["New paragraph"]);
});

test("formatted immersive paragraphs send and cache markers with distinct format identities", async () => {
  const fixture = createFixture();
  const sourceText = "Read the guide carefully.";
  const formattedText = "Read [[YTBT_STRONG_0]]the guide[[/YTBT_STRONG_0]] carefully.";
  const message = immersiveMessage([], { items: [{ id: "im0", sourceText, formattedText }] });
  const response = await fixture.startWorker().request(message);
  assert.equal(response.ok, true);
  assert.equal(fixture.inputs[0][0].text, formattedText);
  const hit = await fixture.startWorker().request({ ...message, cacheOnly: true });
  assert.equal(hit.items[0].translatedText, `Translated: ${formattedText}`);
  assert.equal(fixture.fetchCount, 1);
  const changed = await fixture.startWorker().request({ ...message, cacheOnly: true,
    items: [{ id: "im0", sourceText, formattedText: formattedText.replaceAll("STRONG", "EM") }] });
  assert.equal(changed.items.length, 0);
  const plain = await fixture.startWorker().request(immersiveMessage([sourceText], { cacheOnly: true }));
  assert.equal(plain.items.length, 0, "format markers must never leak into an unformatted paragraph");
});

test("formatted immersive paragraphs reuse existing plain cache without rebilling", async () => {
  const fixture = createFixture();
  const sourceText = "Use readAsString() to read the file.";
  await fixture.startWorker().request(immersiveMessage([sourceText]));
  const message = immersiveMessage([], { items: [{ id: "im0", sourceText,
    formattedText: "Use [[YTBT_CODE_0]]readAsString()[[/YTBT_CODE_0]] to read the file." }] });
  for (const cacheOnly of [true, false]) {
    const response = await fixture.startWorker().request({ ...message, cacheOnly });
    assert.equal(response.ok, true);
    assert.equal(response.items[0].translatedText, `Translated: ${sourceText}`);
    assert.equal(response.items[0].cached, true);
  }
  assert.equal(fixture.fetchCount, 1);
});

test("immersive parallel writes merge without losing paragraphs", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  const texts = Array.from({ length: 24 }, (_, index) => `Paragraph ${index}`);
  const responses = await Promise.all([0, 8, 16].map((start) => worker.request(immersiveMessage(texts.slice(start, start + 8)))));
  assert.ok(responses.every((response) => response.ok));
  const hit = await fixture.startWorker().request(immersiveMessage(texts, { cacheOnly: true }));
  assert.equal(hit.items.length, 24);
  assert.equal(fixture.fetchCount, 3);
});

test("immersive refresh shares in-flight paid work through persistence with different DOM IDs", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  fixture.hooks.beforeSet = (commit) => {
    writeStarted.resolve();
    releaseWrite.promise.then(commit);
  };
  const first = worker.request(immersiveMessage(["Shared paragraph"]));
  await writeStarted.promise;
  const second = worker.request(immersiveMessage([], { items: [{ id: "im99", sourceText: "Shared paragraph" }] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseWrite.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).items[0].id, "im99");
  assert.equal(fixture.fetchCount, 1);
});

test("immersive cache isolates changed text, page, model, languages, endpoint and cache version", async (t) => {
  for (const change of [
    { text: "Changed paragraph" }, { pageUrl: "https://docs.example.com/other" },
    { translationModel: "new-model" }, { targetLanguage: "ja" }, { immersiveSourceLanguage: "fr" },
    { translationBaseUrl: "https://different.example.com/v1" }, { cacheVersion: "2" },
    { immersiveTranslationProvider: "custom", immersiveTranslationBaseUrl: "https://dedicated.example.com/v1", immersiveTranslationModel: "dedicated-model" }
  ]) {
    await t.test(JSON.stringify(change), async () => {
      const fixture = createFixture();
      await fixture.startWorker().request(immersiveMessage(["Original paragraph"]));
      Object.assign(fixture.storage, change);
      const message = immersiveMessage([change.text || "Original paragraph"], { cacheOnly: true });
      if (change.pageUrl) message.pageUrl = change.pageUrl;
      const response = await fixture.startWorker().request(message);
      assert.equal(response.ok, true);
      assert.equal(response.items.length, 0);
      assert.equal(fixture.fetchCount, 1);
    });
  }
});

test("immersive storage failures do not silently repay for a completed translation", async () => {
  const fixture = createFixture();
  const worker = fixture.startWorker();
  fixture.hooks.getError = "Storage unavailable";
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).ok, false);
  assert.equal(fixture.fetchCount, 0);
  delete fixture.hooks.getError;
  fixture.hooks.setError = "QUOTA_BYTES quota exceeded";
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).ok, false);
  assert.equal(fixture.fetchCount, 1);
  const recovered = await worker.request(immersiveMessage(["Paragraph"], { cacheOnly: true }));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.items[0].translatedText, "Translated: Paragraph");
  assert.equal(fixture.fetchCount, 1, "cache-only recovery can use memory after persistence fails");
  delete fixture.hooks.setError;
  assert.equal((await worker.request(immersiveMessage(["Paragraph"]))).ok, true);
  assert.equal(fixture.fetchCount, 1);
  const restored = await fixture.startWorker().request(immersiveMessage(["Paragraph"], { cacheOnly: true }));
  assert.equal(restored.items.length, 1);
});

test("immersive cache validates stored source and bounds changing page history", async () => {
  const fixture = createFixture({ translationCacheMaxItems: 3 });
  const worker = fixture.startWorker();
  await worker.request(immersiveMessage(["One", "Two", "Three"]));
  const cache = translationCaches(fixture)[0][1];
  Object.values(cache.items)[0].sourceText = "Corrupted source";
  assert.equal((await fixture.startWorker().request(immersiveMessage(["One"], { cacheOnly: true }))).items.length, 0);
  await worker.request(immersiveMessage(["Four", "Five"]));
  assert.equal(Object.keys(translationCaches(fixture)[0][1].items).length, 3);
  const cached = await fixture.startWorker().request(immersiveMessage(["Three", "Four", "Five"], { cacheOnly: true }));
  assert.equal(cached.items.length, 3);
});

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

test('explicit Google service skips configured AI and isolates its cache from AI', async () => {
  const fixture = createFixture({immersiveTranslationService:'google-free'});
  fixture.hooks.fetch = (url) => {
    assert.ok(url.startsWith('https://translate.googleapis.com/'));
    assert.equal(new URL(url).searchParams.get('sl'),'auto');
    return freeGoogleResponse();
  };
  const message = immersiveMessage(['Choose Google directly.']);
  const result = await fixture.startWorker().request(message);
  assert.equal(result.ok,true);
  assert.equal(result.items[0].translatedText,'谷歌译文');
  assert.equal(fixture.fetchCount,1);
  assert.equal((await fixture.startWorker().request({...message,cacheOnly:true})).items.length,1);
  assert.equal(fixture.fetchCount,1);
  fixture.storage.immersiveTranslationService='ai';
  assert.equal((await fixture.startWorker().request({...message,cacheOnly:true})).items.length,0);
});

test('a page language snapshot wins over later popup changes throughout a run', async () => {
  const fixture = createFixture({immersiveTranslationService:'google-free',immersiveTargetLanguage:'ja'});
  fixture.hooks.fetch = (url) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('sl'),'fr');
    assert.equal(query.get('tl'),'en');
    return freeGoogleResponse();
  };
  const result = await fixture.startWorker().request(immersiveMessage(['Le texte de cette page.'], {preferences:{immersiveSourceLanguage:'fr',immersiveTargetLanguage:'en',immersiveTranslationService:'google-free'}}));
  assert.equal(result.ok,true);
  assert.equal(result.items.length,1);
});
