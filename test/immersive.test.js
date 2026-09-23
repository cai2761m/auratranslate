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
  window.document.querySelector(".ytbt-immersive-tab").click();
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

async function waitUntil(predicate) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
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
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 16);
      assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='loading']").length, 0);
      retrying = true;
      const beforeRetry = requests.length;
      window.document.querySelector(".ytbt-immersive-tab").click();
      await waitUntil(() => window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState === "done");
      const resent = requests.slice(beforeRetry).filter((request) => !request.cacheOnly).flatMap((request) => Array.from(request.items));
      assert.equal(resent.length, 16);
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
      assert.equal(window.document.querySelectorAll("[data-ytbt-state='paused'][hidden]").length, 12);
      const paidBefore = requests.filter((message) => !message.cacheOnly).length;
      ready = true;
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      window.dispatchEvent(new window.Event("pageshow"));
      await waitUntil(() => window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length === 20);
      assert.equal(requests.filter((message) => !message.cacheOnly).length, paidBefore);
    }
  });
  assert.equal(document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 20);
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
      gates.forEach((release) => release());
      await waitUntil(() => window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length === 20);
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

test("legacy code matching handles overlapping identifiers without styling substrings", async (t) => {
  const { document } = await translatePage(t, `<main><p>Use <code>read</code> or <code>readAsString()</code> to read the whole file.</p></main>`, {
    sendMessage: (message) => ({ ok: true, items: [{ id: message.items[0].id, translatedText: "bread 和 readAsString()、read、readAsString()。" }] })
  });
  assert.deepEqual(Array.from(document.querySelectorAll(".ytbt-immersive-text code"), (node) => node.textContent), ["readAsString()", "read", "readAsString()"]);
});
