const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const sharedScript = fs.readFileSync(path.join(__dirname, "../src/shared.js"), "utf8");
const immersiveScript = fs.readFileSync(path.join(__dirname, "../src/immersive.js"), "utf8");

async function translatePage(t, html, options = {}) {
  const dom = new JSDOM(html, { url: "https://docs.flutter.dev/install/quick", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  // jsdom has no layout engine. Model visibility while exercising real DOM
  // selectors, ancestry, text extraction, rendering, and the public click path.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = this.closest("[hidden], [style*='display: none']");
    return { width: hidden ? 0 : 400, height: hidden ? 0 : 30, top: 0, bottom: 30, ...options.rect?.(this) };
  };
  const getComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => {
    const style = getComputedStyle(element);
    return { display: style.display, visibility: style.visibility, opacity: style.opacity || "1", getPropertyValue: style.getPropertyValue.bind(style) };
  };
  window.chrome = {
    runtime: {},
    storage: { local: { get: (defaults, callback) => callback(defaults), set: (_, callback) => callback() } }
  };
  options.setup?.(window);
  window.eval(sharedScript);
  window.YTBTCore = {
    ...window.YTBTCore,
    async sendRuntimeMessage(_runtime, message) {
      requests.push(message);
      if (options.sendMessage) return options.sendMessage(message);
      if (message.cacheOnly) return { ok: true, items: [] };
      return { ok: true, items: message.items.map((item) => ({ id: item.id, translatedText: `译文：${item.sourceText}` })) };
    }
  };
  window.eval(immersiveScript);
  if (options.start !== false) window.document.querySelector(".ytbt-immersive-tab").click();
  await options.afterStart?.({ window, requests });
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState !== "translating") break;
  }
  assert.equal(window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState, options.expectedState || "done");
  return { document: window.document, requests, texts: requests.filter((request) => !request.cacheOnly).flatMap((request) => request.items.map((item) => item.sourceText)) };
}

test("Flutter callout titles and list items translate once without icon ligatures", async (t) => {
  const { document, texts } = await translatePage(t, `<main><article>
    <h1>Set up and test drive Flutter</h1>
    <aside class="alert alert-info">
      <div class="alert-header"><span translate="no" aria-hidden="true">info</span><span>What you'll achieve</span></div>
      <div class="alert-content"><ul>
        <li>Install the software prerequisites for Flutter.</li>
        <li>Use VS Code to download and install Flutter.</li>
        <li>Create a new Flutter app from a sample template.</li>
        <li>Try out Flutter development features like stateful hot reload.</li>
      </ul></div>
    </aside>
    <aside class="alert"><div class="alert-header"><span aria-hidden="true">info</span><span>Note</span></div>
      <div class="alert-content"><p>Run <code>flutter doctor</code> to verify your installation.</p></div></aside>
  </article></main>`);
  assert.equal(texts.length, 8);
  assert.equal(new Set(texts).size, 8);
  assert.ok(texts.includes("What you'll achieve"));
  assert.ok(texts.includes("Note"));
  assert.ok(texts.includes("Run flutter doctor to verify your installation."));
  assert.ok(texts.every((text) => !text.includes("info")));
  assert.equal(document.querySelectorAll("aside li > [data-ytbt-state='done']").length, 4);
  assert.equal(document.querySelectorAll(".alert-header > [data-ytbt-immersive-translation]").length, 0);
  assert.equal(document.querySelectorAll(".alert-header > span > .ytbt-immersive-stacked").length, 2);
  assert.equal(document.querySelectorAll("[aria-hidden] [data-ytbt-immersive-translation], code [data-ytbt-immersive-translation]").length, 0);
});

test("Flutter outline outside main translates short links and retains anchors", async (t) => {
  const { document, texts, requests } = await translatePage(t, `
    <aside id="side-menu"><nav id="toc-side">
      <header><span aria-hidden="true" translate="no">list</span><span>On this page</span></header>
      <ul class="toc-list">
        <li><span class="sidenav-item"><a href="#dev-platform">Confirm your development platform</a></span></li>
        <li><span class="sidenav-item"><a href="#test-drive">Test drive Flutter</a></span></li>
      </ul>
    </nav></aside>
    <main><h2 id="dev-platform">Confirm your development platform</h2><h2 id="test-drive">Test drive Flutter</h2></main>`);
  assert.equal(texts.length, 5);
  assert.ok(texts.includes("On this page"));
  for (const link of document.querySelectorAll("#toc-side a")) {
    assert.equal(link.querySelectorAll("[data-ytbt-state='done']").length, 1);
    assert.ok(link.querySelector(".ytbt-immersive-stacked"));
    assert.ok(document.querySelector(link.getAttribute("href")));
  }
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation] [data-ytbt-immersive-translation]").length, 0);
  const requestCount = requests.length;
  document.querySelector(".ytbt-immersive-tab").click();
  assert.ok(document.documentElement.classList.contains("ytbt-immersive-hidden"));
  document.querySelector(".ytbt-immersive-tab").click();
  assert.ok(!document.documentElement.classList.contains("ytbt-immersive-hidden"));
  assert.equal(requests.length, requestCount);
});

test("callout and outline exceptions preserve excluded navigation and controls", async (t) => {
  const { texts } = await translatePage(t, `
    <header><nav><a>Global navigation must stay excluded here</a></nav></header>
    <aside><p>Unrelated sidebar must stay excluded here.</p></aside>
    <aside class="alert"><p>Outside content must stay excluded here.</p></aside>
    <main><p>Ordinary content still translates as before.</p>
      <nav><aside class="alert"><p>Nested navigation must stay excluded here.</p></aside></nav>
      <aside class="alert"><div class="alert-header">Note</div><div class="alert-content">
        <button>Button content must stay excluded here.</button>
        <pre>Code samples must stay excluded here.</pre>
        <p aria-hidden="true">Hidden content must stay excluded here.</p>
        <p hidden>Hidden content must stay excluded here too.</p>
        <p translate="no">Opted out content must stay excluded here.</p>
        <p contenteditable="true">Editable content must stay excluded here.</p>
      </div></aside>
    </main>
    <aside><nav id="toc"><a href="#intro">Intro</a><button>Another excluded button in the outline</button></nav></aside>`);
  assert.deepEqual(texts, ["Ordinary content still translates as before.", "Note", "Intro"]);
});

test("semantic outlines and admonitions support nested lists without duplicate blocks", async (t) => {
  const { document, texts } = await translatePage(t, `
    <nav role="doc-toc"><ul><li><a href="#setup">Setup</a>
      <ul><li><a href="#run">Run</a></li></ul></li></ul></nav>
    <article><aside class="admonition"><p class="admonition-title">Tip</p>
      <p>Read this useful tip before proceeding.</p></aside>
      <aside role="note"><h3>Reminder</h3><p>Save your work before closing the editor.</p></aside>
    </article>`);
  assert.deepEqual(texts, ["Setup", "Run", "Tip", "Read this useful tip before proceeding.", "Reminder", "Save your work before closing the editor."]);
  assert.equal(document.querySelectorAll("nav a > [data-ytbt-state='done']").length, 2);
});

async function waitUntil(predicate, options = {}) {
  const turns = options.turns ?? 100;
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => options.delayMs ? setTimeout(resolve, options.delayMs) : setImmediate(resolve));
  }
  assert.fail("Expected async progress did not occur");
}

function translatedResponse(message) {
  return { ok: true, items: message.items.map((item) => ({ id: item.id, translatedText: `译文：${item.sourceText}` })) };
}

function paragraphs(count) {
  return `<main>${Array.from({ length: count }, (_, index) =>
    `<p data-index="${index}">This is readable paragraph number ${index}.</p>`).join("")}</main>`;
}

function cachePollClock(window) {
  const timers = new Map();
  let serial = 100000;
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  window.setTimeout = (callback, ms, ...args) => {
    if (ms !== 5000) return set(callback, ms, ...args);
    const id = ++serial;
    timers.set(id, callback);
    return id;
  };
  window.clearTimeout = (id) => {
    if (!timers.delete(id)) clear(id);
  };
  return {
    timers,
    async tick() {
      const due = [...timers.values()];
      timers.clear();
      due.forEach((callback) => callback());
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test("stuck paid response channels finish from cache probes and ignore late errors", async (t) => {
  let clock;
  let ready = false;
  const rejectPaid = [];
  const { requests } = await translatePage(t, paragraphs(8), {
    setup(window) { clock = cachePollClock(window); },
    sendMessage(message) {
      if (message.cacheOnly) return ready ? translatedResponse(message) : { ok: true, items: [] };
      return new Promise((_, reject) => rejectPaid.push(reject));
    },
    async afterStart({ window }) {
      await waitUntil(() => rejectPaid.length === 2);
      await clock.tick();
      assert.equal(clock.timers.size, 2, "incomplete cache must not finish paid work");
      ready = true;
      await clock.tick();
      await waitUntil(() => window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState === "done");
      rejectPaid.forEach((reject) => reject(new Error("Translation request timeout: background did not respond.")));
      await clock.tick();
      assert.equal(clock.timers.size, 0);
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 8);
    }
  });
  assert.equal(requests.filter((message) => !message.cacheOnly).length, 2);
});

test("foreground timeout recovery polls late results without tab switches or paid replays", async (t) => {
  let clock;
  let ready = false;
  const { requests } = await translatePage(t, paragraphs(8), {
    setup(window) { clock = cachePollClock(window); },
    sendMessage(message) {
      if (message.cacheOnly) return ready ? translatedResponse(message) : { ok: true, items: [] };
      throw new Error("Translation request timeout: background did not respond.");
    },
    async afterStart({ window }) {
      await waitUntil(() => clock.timers.size === 1);
      await clock.tick();
      assert.equal(window.document.querySelectorAll("[data-ytbt-state='waiting']").length, 8);
      ready = true;
      await clock.tick();
      await waitUntil(() => window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState === "done");
      assert.equal(clock.timers.size, 0);
    }
  });
  assert.equal(requests.filter((message) => !message.cacheOnly).length, 2);
});

test("unrecoverable timeouts stop background polling after a bounded recovery window", async (t) => {
  let clock;
  const { requests } = await translatePage(t, paragraphs(8), {
    expectedState: "error",
    setup(window) { clock = cachePollClock(window); },
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: [] };
      throw new Error("The message port closed before a response was received.");
    },
    async afterStart() {
      await waitUntil(() => clock.timers.size === 1);
      for (let i = 0; i < 12; i++) await clock.tick();
      assert.equal(clock.timers.size, 0, "idle pages must not poll forever");
    }
  });
  assert.equal(requests.filter((message) => !message.cacheOnly).length, 2);
  assert.equal(requests.filter((message) => message.cacheOnly).length, 13);
});

test("cache progress probes never overlap and stop after navigation", async (t) => {
  let clock;
  let resolveProbe;
  let resolvePaid;
  const { requests, document } = await translatePage(t, paragraphs(4), {
    expectedState: "idle",
    setup(window) { clock = cachePollClock(window); },
    sendMessage(message) {
      if (!message.cacheOnly) return new Promise((resolve) => { resolvePaid = () => resolve(translatedResponse(message)); });
      if (!resolvePaid) return { ok: true, items: [] };
      return new Promise((resolve) => { resolveProbe = () => resolve(translatedResponse(message)); });
    },
    async afterStart({ window }) {
      await waitUntil(() => resolvePaid);
      await clock.tick();
      assert.ok(resolveProbe);
      await clock.tick();
      assert.equal(clock.timers.size, 0, "wait for a slow probe before scheduling another");
      window.history.pushState({}, "", "/different-page");
      window.dispatchEvent(new window.Event("popstate"));
      resolveProbe();
      resolvePaid();
      await clock.tick();
      assert.equal(clock.timers.size, 0);
    }
  });
  assert.equal(requests.length, 3);
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation]").length, 0);
});

test("page scheduler prioritizes viewport, reorders after scrolling and renders out of order with at most three requests", async (t) => {
  let focusedIndex = 24;
  let active = 0;
  let peak = 0;
  const gates = [];
  const { document, requests } = await translatePage(t, paragraphs(40), {
    rect(element) {
      const index = Number(element.dataset.index);
      const top = Number.isFinite(index) ? (index - focusedIndex) * 200 + 10 : 0;
      return { top, bottom: top + 30 };
    },
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: [] };
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => gates.push({ message, release() {
        active -= 1;
        resolve(translatedResponse(message));
      } }));
    },
    async afterStart({ window }) {
      await waitUntil(() => gates.length === 3);
      assert.deepEqual(Array.from(gates[0].message.items, (item) => item.id), ["im24", "im25", "im26", "im27"]);
      assert.equal(active, 3, "three batches must start before any response");
      const firstId = gates[0].message.items[0].id;
      const secondId = gates[1].message.items[0].id;
      focusedIndex = 39;
      gates[1].release();
      await waitUntil(() => gates.length === 4);
      assert.equal(gates[3].message.items[0].id, "im39", "newly visible paragraph goes next");
      assert.equal(gates[3].message.items.length, 1, "scrolling keeps visible text separate from offscreen work");
      assert.equal(window.document.querySelector(`[data-ytbt-immersive-for='${firstId}']`).dataset.ytbtState, "loading");
      assert.equal(window.document.querySelector(`[data-ytbt-immersive-for='${secondId}']`).dataset.ytbtState, "done");
      gates[0].release();
      gates[2].release();
      let released = 3;
      await waitUntil(() => {
        while (released < gates.length) gates[released++].release();
        return window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState === "done";
      });
    }
  });
  assert.equal(peak, 3);
  const sent = requests.filter((request) => !request.cacheOnly).flatMap((request) => Array.from(request.items, (item) => item.id));
  assert.equal(sent.length, 40);
  assert.equal(new Set(sent).size, 40);
  assert.equal(document.querySelectorAll("[data-ytbt-state='done'][data-ytbt-immersive-translation]").length, 40);
});

test("cached paragraphs appear before paid responses and are never scheduled again", async (t) => {
  let release;
  const { requests, document } = await translatePage(t, paragraphs(6), {
    sendMessage(message) {
      if (message.cacheOnly) return translatedResponse({ items: message.items.slice(0, 2) });
      return new Promise((resolve) => { release = () => resolve(translatedResponse(message)); });
    },
    async afterStart({ window }) {
      await waitUntil(() => release);
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 2);
      release();
    }
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(requests[1].items, (item) => item.id), ["im2", "im3", "im4", "im5"]);
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 6);
});

test("visible short text never waits in a batch with offscreen long paragraphs", async (t) => {
  const longText = "This long paragraph is outside the current viewport. ".repeat(45);
  const { requests } = await translatePage(t, `<main><p data-index="0">Read this visible introduction first.</p>${
    Array.from({ length: 7 }, (_, index) => `<p data-index="${index + 1}">${longText}</p>`).join("")}</main>`, {
    rect(element) {
      const top = Number(element.dataset.index) > 0 ? 1500 : 10;
      return { top, bottom: top + 30 };
    }
  });
  const paid = requests.filter((request) => !request.cacheOnly);
  assert.deepEqual(Array.from(paid[0].items, (item) => item.id), ["im0"]);
  assert.equal(paid.flatMap((request) => Array.from(request.items)).length, 8);
  assert.ok(paid.slice(1).some((request) => request.items.length > 1), "offscreen work still uses larger batches");
});

test("all visible batches bound generation work including inline formatting", async (t) => {
  const text = "Translate this readable paragraph with its formatting intact. ".repeat(11);
  const { requests } = await translatePage(t, `<main>${Array.from({ length: 12 }, (_, index) =>
    `<p>${index}: <em>${text}</em> <code>readAsString()</code></p>`).join("")}</main>`);
  const paid = requests.filter((request) => !request.cacheOnly);
  assert.ok(paid.length > 3, "visible text should not fill three large generation requests");
  for (const request of paid) {
    assert.ok(request.items.length <= 4);
    assert.ok(request.items.reduce((total, item) => total + item.formattedText.length, 0) <= 1800);
  }
  assert.equal(new Set(paid.flatMap((request) => Array.from(request.items, (item) => item.id))).size, 12);
});

test("partial cache progress renders before the batch finishes and counts each block once", async (t) => {
  let clock;
  let release;
  let partial = false;
  const { document, requests } = await translatePage(t, paragraphs(4), {
    setup(window) { clock = cachePollClock(window); },
    sendMessage(message) {
      if (message.cacheOnly) return partial ? translatedResponse({ items: message.items.slice(0, 1) }) : { ok: true, items: [] };
      return new Promise((resolve) => { release = () => resolve(translatedResponse({ items: message.items.slice(1) })); });
    },
    async afterStart({ window }) {
      await waitUntil(() => release);
      partial = true;
      await clock.tick();
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 1);
      assert.equal(window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState, "translating");
      await clock.tick();
      assert.match(window.document.querySelector(".ytbt-immersive-panel").textContent, /Translating 1\/4 blocks/);
      release();
    }
  });
  assert.match(document.querySelector(".ytbt-immersive-panel").textContent, /Done\. Added 4 bilingual translations/);
  assert.equal(requests.filter((request) => !request.cacheOnly).length, 1);
  assert.equal(clock.timers.size, 0);
});

test("a late batch failure preserves paragraphs already rendered from cache progress", async (t) => {
  let clock;
  let fail;
  let partial = false;
  const { document, requests } = await translatePage(t, paragraphs(4), {
    expectedState: "error",
    setup(window) { clock = cachePollClock(window); },
    sendMessage(message) {
      if (message.cacheOnly) return partial ? translatedResponse({ items: message.items.slice(0, 1) }) : { ok: true, items: [] };
      return new Promise((_, reject) => { fail = () => reject(new Error("Provider unavailable")); });
    },
    async afterStart() {
      await waitUntil(() => fail);
      partial = true;
      await clock.tick();
      fail();
    }
  });
  assert.equal(document.querySelector("[data-ytbt-immersive-for='im0']").dataset.ytbtState, "done");
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='error']").length, 3);
  assert.equal(requests.filter((request) => !request.cacheOnly).length, 1);
});

test("full cache hit and cache-read failure never issue paid page messages", async (t) => {
  const hit = await translatePage(t, paragraphs(8), { sendMessage: (message) => translatedResponse(message) });
  assert.equal(hit.requests.length, 1);
  assert.equal(hit.requests[0].cacheOnly, true);
  const failed = await translatePage(t, paragraphs(8), {
    expectedState: "error",
    sendMessage: () => ({ ok: false, errors: [{ message: "Unable to read cache" }] })
  });
  assert.equal(failed.requests.length, 1);
  assert.match(failed.document.querySelector(".ytbt-immersive-panel").textContent, /Unable to read cache/);
});

test("a failed concurrent batch stops new work while late successes survive and retry hydrates them", async (t) => {
  const gates = [];
  const cached = new Map();
  let retrying = false;
  const { document, requests } = await translatePage(t, paragraphs(32), {
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: message.items.filter((item) => cached.has(item.id)).map((item) => cached.get(item.id)) };
      if (retrying) return translatedResponse(message);
      return new Promise((resolve) => gates.push({ message, resolve }));
    },
    async afterStart({ window, requests }) {
      await waitUntil(() => gates.length === 3);
      gates[0].resolve({ ok: false, errors: [{ message: "Provider unavailable" }] });
      await new Promise((resolve) => setImmediate(resolve));
      for (const gate of gates.slice(1)) {
        const response = translatedResponse(gate.message);
        response.items.forEach((item) => cached.set(item.id, item));
        gate.resolve(response);
      }
      await waitUntil(() => window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState === "error");
      assert.equal(gates.length, 3, "unsent work must stop after failure");
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, cached.size);
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='loading']").length, 0);
      retrying = true;
      const beforeRetry = requests.length;
      window.document.querySelector(".ytbt-immersive-tab").click();
      await waitUntil(() => window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState === "done");
      const resent = requests.slice(beforeRetry).filter((request) => !request.cacheOnly).flatMap((request) => Array.from(request.items));
      assert.equal(resent.length, 32 - cached.size);
      assert.ok(resent.every((item) => !cached.has(item.id)));
    }
  });
  assert.equal(requests.filter((request) => request.cacheOnly).length, 2);
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 32);
});

test("long paragraphs remain within per-request character limits", async (t) => {
  const text = "This sentence is sufficiently long to exercise batching. ".repeat(50);
  const { requests } = await translatePage(t, `<main>${Array.from({ length: 8 }, () => `<p>${text}</p>`).join("")}</main>`);
  for (const request of requests.filter((request) => !request.cacheOnly)) {
    assert.ok(request.items.length <= 8);
    assert.ok(request.items.reduce((total, item) => total + item.sourceText.length, 0) <= 7000);
  }
});

test("lost responses recover saved translations using cache-only requests without paid replays", async (t) => {
  let cacheReads = 0;
  const { document, requests } = await translatePage(t, paragraphs(8), {
    sendMessage(message) {
      if (message.cacheOnly) return ++cacheReads === 1 ? { ok: true, items: [] } : translatedResponse(message);
      throw new Error("Translation request timeout: background did not respond.");
    }
  });
  assert.equal(requests.filter((message) => !message.cacheOnly).length, 2);
  assert.equal(cacheReads, 2);
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 8);
  assert.equal(document.querySelectorAll("[data-ytbt-state='error']").length, 0);
});

test("returning to a tab restores late cached results but never resends uncertain or unsent work", async (t) => {
  let ready = false;
  const sent = new Set();
  const { document, requests } = await translatePage(t, paragraphs(32), {
    expectedState: "error",
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: ready
        ? translatedResponse(message).items.filter((item) => sent.has(item.id)) : [] };
      message.items.forEach((item) => sent.add(item.id));
      throw new Error("The message port closed before a response was received.");
    },
    async afterStart({ window, requests }) {
      await waitUntil(() => requests.filter((message) => message.cacheOnly).length === 2);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(window.document.querySelectorAll("[data-ytbt-state='error']").length, 1, "only the control shows an error, not every paragraph");
      assert.equal(window.document.querySelectorAll("[data-ytbt-state='paused'][hidden]").length, 32 - sent.size);
      const paidBefore = requests.filter((message) => !message.cacheOnly).length;
      ready = true;
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      window.dispatchEvent(new window.Event("pageshow"));
      await waitUntil(() => window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length === sent.size);
      assert.equal(requests.filter((message) => !message.cacheOnly).length, paidBefore);
    }
  });
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, sent.size);
  assert.equal(requests.filter((message) => !message.cacheOnly).length, 3);
});

test("hidden tabs pause unsent batches and continue once visible without duplicating sent text", async (t) => {
  const gates = [];
  let hold = true;
  const { requests } = await translatePage(t, paragraphs(32), {
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: [] };
      if (!hold) return translatedResponse(message);
      return new Promise((resolve) => gates.push(() => resolve(translatedResponse(message))));
    },
    async afterStart({ window, requests }) {
      await waitUntil(() => gates.length === 3);
      let hidden = true;
      Object.defineProperty(window.document, "hidden", { get: () => hidden });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      hold = false;
      const sentCount = requests.filter((message) => !message.cacheOnly).reduce((total, message) => total + message.items.length, 0);
      gates.forEach((release) => release());
      await waitUntil(() => window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length === sentCount);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.filter((message) => !message.cacheOnly).length, 3);
      hidden = false;
      window.document.dispatchEvent(new window.Event("visibilitychange"));
    }
  });
  const ids = requests.filter((message) => !message.cacheOnly).flatMap((message) => Array.from(message.items, (item) => item.id));
  assert.equal(ids.length, 32);
  assert.equal(new Set(ids).size, 32);
});

test("SPA navigation discards late failures and retains the original request URL", async (t) => {
  const gates = [];
  const { document, requests } = await translatePage(t, paragraphs(32), {
    expectedState: "idle",
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: [] };
      return new Promise((resolve, reject) => gates.push(reject));
    },
    async afterStart({ window }) {
      await waitUntil(() => gates.length === 3);
      window.history.pushState({}, "", "/new-article");
      window.document.querySelector("main").innerHTML = "<p>The next article must not receive the old errors.</p>";
      gates.forEach((reject) => reject(new Error("Translation request timeout: background did not respond.")));
    }
  });
  assert.equal(requests.length, 4);
  assert.ok(requests.every((message) => message.pageUrl === "https://docs.flutter.dev/install/quick"));
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation]").length, 0);
  assert.equal(document.querySelector(".ytbt-immersive-panel").hidden, true);
});

test("cached Dart paragraph restores inline code appearance without paid requests", async (t) => {
  const { document, requests } = await translatePage(t, `<style>
    p > code { background-color: rgb(240, 242, 244); border: 1px solid gray; border-radius: 4px; font-family: monospace; padding: 2px; }
    </style><main><p>When reading a text file, use <code id="read" class="language-dart" onclick="alert(1)">readAsString()</code>
    or use <code>readAsLines()</code> when individual lines are important.</p></main>`, {
    sendMessage(message) {
      assert.equal(message.cacheOnly, true);
      return { ok: true, items: [{ id: message.items[0].id, translatedText: "读取文本文件时，使用 readAsString()。需要逐行读取时，使用 `readAsLines()`。" }] };
    }
  });
  assert.equal(requests.length, 1);
  const translation = document.querySelector(".ytbt-immersive-text");
  assert.deepEqual(Array.from(translation.querySelectorAll("code"), (node) => node.textContent), ["readAsString()", "readAsLines()"]);
  const code = translation.querySelector("code");
  assert.equal(code.style.backgroundColor, "rgb(240, 242, 244)");
  assert.equal(code.style.fontFamily, "monospace");
  assert.equal(code.style.borderRadius, "4px");
  assert.equal(code.className, "language-dart");
  assert.equal(code.hasAttribute("id"), false);
  assert.equal(code.hasAttribute("onclick"), false);
  assert.equal(document.querySelectorAll("#read").length, 1);
  assert.equal(translation.textContent, "读取文本文件时，使用 readAsString()。需要逐行读取时，使用 readAsLines()。");
});

test("new translations preserve reordered nested formatting, links, breaks and exact code", async (t) => {
  const { document, requests } = await translatePage(t, `<main><p>Read <strong>the <em>important</em> guide</strong>
    at <a href="/guide" onclick="alert(1)">this link</a><br>and call <code>readAsString()</code> for the entire file.</p></main>`, {
    sendMessage(message) {
      if (message.cacheOnly) return { ok: true, items: [] };
      assert.match(message.items[0].formattedText, /\[\[YTBT_CODE_4\]\]readAsString\(\)\[\[\/YTBT_CODE_4\]\]/);
      return { ok: true, items: [{ id: message.items[0].id, translatedText:
        "通过[[YTBT_A_2]]此链接[[/YTBT_A_2]]阅读[[YTBT_STRONG_0]][[YTBT_EM_1]]重要[[/YTBT_EM_1]]指南[[/YTBT_STRONG_0]][[YTBT_BR_3]][[/YTBT_BR_3]]并调用[[YTBT_CODE_4]]changedByModel()[[/YTBT_CODE_4]]读取整个文件。" }] };
    }
  });
  assert.equal(requests.length, 2);
  const translation = document.querySelector(".ytbt-immersive-text");
  assert.equal(translation.querySelector("strong > em").textContent, "重要");
  assert.equal(translation.querySelector("a").getAttribute("href"), "/guide");
  assert.equal(translation.querySelector("a").hasAttribute("onclick"), false);
  assert.equal(translation.querySelectorAll("br").length, 1);
  assert.equal(translation.querySelector("code").textContent, "readAsString()");
  assert.equal(translation.textContent, "通过此链接阅读重要指南并调用readAsString()读取整个文件。");
});

test("malformed or missing formatting markers fall back to safe text and literal code", async (t) => {
  for (const translatedText of [
    "[[YTBT_CODE_0]]readAsString() 未闭合。",
    "[[YTBT_CODE_99]]readAsString()[[/YTBT_CODE_99]] 未知标记。",
    "使用 readAsString() 和 readAsString()。"
  ]) {
    const { document } = await translatePage(t, `<main><p>Use <code>readAsString()</code> to read the whole text file.</p></main>`, {
      sendMessage: (message) => ({ ok: true, items: [{ id: message.items[0].id, translatedText }] })
    });
    const translation = document.querySelector(".ytbt-immersive-text");
    assert.ok(translation.querySelector("code"));
    assert.doesNotMatch(translation.textContent, /YTBT_/);
    assert.equal(translation.textContent, translatedText.replace(/\[\[\/?YTBT_[A-Z]+_\d+\]\]/g, ""));
  }
});

test("formatting copies no active source attributes and keeps code-like HTML inert", async (t) => {
  const { document } = await translatePage(t, `<main><p>Compare <code>&lt;img src=x onerror=alert(1)&gt;</code>
    with <a href="javascript:alert(1)">this unsafe link</a> in the example.</p></main>`, {
    sendMessage: (message) => ({ ok: true, items: [{ id: message.items[0].id, translatedText:
      "比较 [[YTBT_CODE_0]]example[[/YTBT_CODE_0]] 与 [[YTBT_A_1]]链接[[/YTBT_A_1]]。" }] })
  });
  const translation = document.querySelector(".ytbt-immersive-text");
  assert.equal(translation.querySelector("code").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(translation.querySelector("a").hasAttribute("href"), false);
  assert.equal(translation.querySelector("img, [onerror], [onclick]"), null);
});

// The floating control must never push translation progress on screen on its
// own; hovering it (or the open panel) is the only thing that reveals it.
function createControlFixture(t, html) {
  const dom = new JSDOM(html, { url: "https://docs.flutter.dev/install/quick", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  const pending = [];
  // jsdom has no layout engine; model visibility the same way translatePage does.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = this.closest("[hidden], [style*='display: none']");
    return { width: hidden ? 0 : 400, height: hidden ? 0 : 30, top: 0, bottom: 30 };
  };
  const getComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => {
    const style = getComputedStyle(element);
    return { display: style.display, visibility: style.visibility, opacity: style.opacity || "1", getPropertyValue: style.getPropertyValue.bind(style) };
  };
  window.chrome = {
    runtime: {},
    storage: { local: { get: (defaults, callback) => callback(defaults), set: (_, callback) => callback() } }
  };
  window.eval(sharedScript);
  window.YTBTCore = {
    ...window.YTBTCore,
    sendRuntimeMessage(_runtime, message) {
      requests.push(message);
      if (message.cacheOnly) return Promise.resolve({ ok: true, items: [] });
      return new Promise((resolve, reject) => pending.push({ message, resolve, reject }));
    }
  };
  window.eval(immersiveScript);
  return { window, document: window.document, requests, pending };
}

test("translation progress stays hidden until the pointer is on the floating control", async (t) => {
  const { window, document, pending } = createControlFixture(t, `<main>${paragraphs(8)}</main>`);
  const ball = document.querySelector(".ytbt-immersive-tab");
  const panel = document.querySelector(".ytbt-immersive-panel");

  ball.click();
  // One 4-block first batch plus the remaining 4 blocks in a second batch.
  await waitUntil(() => pending.length === 2 && panel.textContent);
  assert.equal(ball.dataset.ytbtState, "translating");
  assert.equal(panel.hidden, true, "progress must not pop up on its own while translating");
  assert.match(panel.textContent, /Translating 0\/8 blocks/);
  assert.equal(document.body.contains(panel), true);

  // jsdom cannot synthesize hover, so model the pointer entering the control.
  ball.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(panel.hidden, false, "hovering the control reveals progress");
  assert.match(panel.textContent, /Translating 0\/8 blocks/);

  pending.forEach(({ message, resolve }) => resolve(translatedResponse(message)));
  await waitUntil(() => ball.dataset.ytbtState === "done" && /Done\b/.test(panel.textContent));
  assert.equal(panel.hidden, false, "the panel stays open for the pointer already on it");
  assert.match(panel.textContent, /Done\. Added 8 bilingual translations/);

  ball.dispatchEvent(new window.Event("pointerleave"));
  assert.equal(panel.hidden, true, "leaving the control hides the panel again");
});

test("errors and notices stay reachable by hover instead of popping up", async (t) => {
  const { window, document, pending } = createControlFixture(t, `<main>${paragraphs(8)}</main>`);
  const ball = document.querySelector(".ytbt-immersive-tab");
  const panel = document.querySelector(".ytbt-immersive-panel");

  // Reject synchronously so the failure is fully settled when the run stops.
  window.YTBTCore.sendRuntimeMessage = (_runtime, message) => {
    if (message.cacheOnly) return Promise.resolve({ ok: true, items: [] });
    return Promise.resolve({ ok: false, errors: [{ message: "Provider unavailable" }] });
  };

  ball.click();
  await waitUntil(() => ball.dataset.ytbtState === "error");
  await waitUntil(() => /翻译暂停/.test(panel.textContent));

  assert.equal(panel.hidden, true, "a failure must not pop a panel over the page text");
  assert.match(panel.textContent, /Provider unavailable/);

  ball.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /翻译暂停/);
  ball.dispatchEvent(new window.Event("pointerleave"));
  assert.equal(panel.hidden, true);
});

test("a toggle notice is a hover-only toast, not a permanent panel", async (t) => {
  const { window, document } = createControlFixture(t, `<main>${paragraphs(8)}</main>`);

  // Serve every block from cache so the first click reaches the done state.
  window.YTBTCore.sendRuntimeMessage = (_runtime, message) =>
    Promise.resolve(translatedResponse(message));

  const ball = document.querySelector(".ytbt-immersive-tab");
  const panel = document.querySelector(".ytbt-immersive-panel");

  ball.click();
  await waitUntil(() => ball.dataset.ytbtState === "done");

  ball.click();
  await waitUntil(() => /Bilingual translations hidden/.test(panel.textContent));
  assert.equal(panel.hidden, true, "click notices are hover-only too");

  ball.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Bilingual translations hidden/);

  // The notice is transient: it expires by itself even without hovering.
  await new Promise((resolve) => window.setTimeout(resolve, 3700));
  assert.equal(panel.textContent, "");
  assert.equal(panel.hidden, true);
});

test("SPA navigation clears the stored status so a stale message cannot resurface", async (t) => {
  const { window, document, pending } = createControlFixture(t, `<main>${paragraphs(8)}</main>`);
  const ball = document.querySelector(".ytbt-immersive-tab");
  const panel = document.querySelector(".ytbt-immersive-panel");

  ball.click();
  await waitUntil(() => pending.length === 2 && /Translating/.test(panel.textContent));

  window.history.pushState({}, "", "/new-article");
  // SPA navigation is detected by a one-second identity poll, so allow real time.
  await waitUntil(() => ball.dataset.ytbtState === "idle" && !panel.textContent, { turns: 200, delayMs: 20 });
  assert.equal(panel.hidden, true);
  ball.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(panel.hidden, true, "no progress from the previous page may come back");
});

test("legacy code matching handles overlapping identifiers without styling substrings", async (t) => {
  const { document } = await translatePage(t, `<main><p>Use <code>read</code> or <code>readAsString()</code> to read the whole file.</p></main>`, {
    sendMessage: (message) => ({ ok: true, items: [{ id: message.items[0].id, translatedText: "bread 和 readAsString()、read、readAsString()。" }] })
  });
  assert.deepEqual(Array.from(document.querySelectorAll(".ytbt-immersive-text code"), (node) => node.textContent), ["readAsString()", "read", "readAsString()"]);
});

test("popup mode changes reuse translations and preserve original DOM nodes and listeners", async (t) => {
  let changed;
  let clicks = 0;
  let originalLink;
  const {document,requests} = await translatePage(t, '<main><p>Read this <a href="#guide">detailed guide</a> before proceeding.</p></main>', {
    setup(window) {
      window.chrome.storage.onChanged = {addListener(fn) { changed = fn; }};
      originalLink = window.document.querySelector('a');
      originalLink.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    }
  });
  const count = requests.length;
  changed({immersiveDisplayMode:{newValue:'translation'}}, 'local');
  assert.ok(document.documentElement.classList.contains('ytbt-translation-only'));
  assert.equal(document.querySelector('[data-ytbt-original] a'),originalLink);
  assert.equal(document.querySelectorAll('[data-ytbt-original]').length,1);
  document.querySelector('.ytbt-immersive-tab').click();
  assert.ok(document.documentElement.classList.contains('ytbt-immersive-hidden'));
  changed({immersiveDisplayMode:{newValue:'bilingual'}}, 'local');
  assert.equal(document.querySelector('[data-ytbt-original]'),null);
  assert.equal(document.querySelector('p > a'),originalLink);
  originalLink.click();
  assert.equal(clicks,1);
  assert.equal(requests.length,count);
});

test("popup messages start translation without toggling results and pass a stable language profile", async (t) => {
  let listener;
  const {requests} = await translatePage(t, paragraphs(1), {
    start:false,
    setup(window) {
      window.chrome.runtime.onMessage = {addListener(fn) { listener = fn; }};
      window.chrome.storage.local.get = (defaults, callback) => callback({...defaults, immersiveSourceLanguage:'en',immersiveTargetLanguage:'ja',immersiveTranslationService:'google-free'});
    },
    afterStart() {
      let reply;
      listener({type:'IMMERSIVE_POPUP_TRANSLATE'}, {}, (value) => {reply = value;});
      assert.equal(reply.ok,true);
      assert.equal(reply.mode,'translating');
      listener({type:'IMMERSIVE_POPUP_TRANSLATE'}, {}, () => {});
    }
  });
  assert.equal(requests.filter((request) => !request.cacheOnly).length,1);
  assert.equal(requests[0].preferences.immersiveSourceLanguage,'en');
  assert.equal(requests[0].preferences.immersiveTargetLanguage,'ja');
  assert.equal(requests[0].preferences.immersiveTranslationService,'google-free');
  assert.equal(requests[0].preferences.translationApiKey,undefined);
});

test("website rules override global automatic translation and default stays manual", async (t) => {
  for (const [global,rule,expected] of [[false,'always','done'],[true,'never','idle'],[true,undefined,'done'],[false,undefined,'idle']]) {
    const {requests} = await translatePage(t, paragraphs(1), {
      start:false,expectedState:expected,
      setup(window) {
        window.chrome.storage.local.get = (defaults, callback) => callback({...defaults,
          immersiveAutoTranslate:global,immersiveSiteRules:{'docs.flutter.dev':rule}});
      }
    });
    assert.equal(requests.some((request) => !request.cacheOnly), expected === 'done');
  }
});

test("Japanese paragraphs can translate when auto detection targets Chinese", async (t) => {
  const {texts} = await translatePage(t, '<main><p>このページの設定方法を確認してください。</p></main>');
  assert.equal(texts.length,1);
});
