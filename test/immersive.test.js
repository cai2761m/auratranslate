const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const sharedScript = fs.readFileSync(path.join(__dirname, "../src/shared.js"), "utf8");
const immersiveScript = fs.readFileSync(path.join(__dirname, "../src/immersive.js"), "utf8");

async function translatePage(t, html) {
  const dom = new JSDOM(html, { url: "https://docs.flutter.dev/install/quick", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  // jsdom has no layout engine. Model visibility while exercising real DOM
  // selectors, ancestry, text extraction, rendering, and the public click path.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = this.closest("[hidden], [style*='display: none']");
    return { width: hidden ? 0 : 400, height: hidden ? 0 : 30 };
  };
  const getComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => {
    const style = getComputedStyle(element);
    return { display: style.display, visibility: style.visibility, opacity: style.opacity || "1" };
  };
  window.chrome = {
    runtime: {},
    storage: { local: { get: (defaults, callback) => callback(defaults), set: (_, callback) => callback() } }
  };
  window.eval(sharedScript);
  window.YTBTCore = {
    ...window.YTBTCore,
    async sendRuntimeMessage(_runtime, message) {
      requests.push(message);
      return { ok: true, items: message.items.map((item) => ({ id: item.id, translatedText: `译文：${item.sourceText}` })) };
    }
  };
  window.eval(immersiveScript);
  window.document.querySelector(".ytbt-immersive-tab").click();
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState !== "translating") break;
  }
  assert.equal(window.document.querySelector(".ytbt-immersive-tab").dataset.ytbtState, "done");
  return { document: window.document, requests, texts: requests.flatMap((request) => request.items.map((item) => item.sourceText)) };
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
