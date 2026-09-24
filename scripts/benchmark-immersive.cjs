// Controlled DOM/scheduler benchmark, not real browser or provider timings.
// Usage: node scripts/benchmark-immersive.cjs <baseline-git-ref>
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { JSDOM } = require("jsdom");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const baseline = process.argv[2];
if (!baseline) throw new Error("Pass a baseline Git ref for comparison.");
const extensionScripts = require("./extension-scripts.cjs");
const shared = extensionScripts.source("shared");
const baselineManifest = JSON.parse(execFileSync("git", ["show", `${baseline}:manifest.json`], { cwd: root, encoding: "utf8" }));
const baselineFiles = baselineManifest.content_scripts.find(entry => entry.js.includes("src/immersive.js"))
  .js.filter(file => /\/immersive(?:-|\.)/.test(file));
const sources = {
  baseline: baselineFiles.map(file => execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })).join("\n;\n"),
  current: extensionScripts.source("immersive")
};
const longText = "This offscreen paragraph contains detailed instructions for the next section. ".repeat(30);
const html = `<main><p data-index="0">Read this visible introduction first.</p>${
  Array.from({ length: 15 }, (_, index) => `<p data-index="${index + 1}">${index}: ${longText}</p>`).join("")}</main>`;

async function run(source, cache) {
  const dom = new JSDOM(html, { url: "https://example.com/benchmark", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  let active = 0;
  let peak = 0;
  let requests = 0;
  let firstVisibleMs;
  const sent = new Set();
  try {
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      const top = Number(this.dataset.index) > 0 ? 1500 + Number(this.dataset.index) * 100 : 10;
      return { width: 400, height: 30, top, bottom: top + 30 };
    };
    const computed = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element) => {
      const style = computed(element);
      return { display: style.display, visibility: style.visibility, opacity: style.opacity || "1", getPropertyValue: style.getPropertyValue.bind(style) };
    };
    window.chrome = { runtime: {}, storage: { local: {
      get: (defaults, done) => done(defaults), set: (_, done) => done()
    } } };
    window.eval(shared);
    window.YTBTCore = { ...window.YTBTCore, async sendRuntimeMessage(_, message) {
      if (message.cacheOnly) return { ok: true, items: message.items.filter((item) => cache.has(item.sourceText))
        .map((item) => ({ id: item.id, translatedText: cache.get(item.sourceText) })) };
      requests += 1;
      active += 1;
      peak = Math.max(peak, active);
      for (const item of message.items) {
        assert.ok(!sent.has(item.sourceText), "no duplicate paid source text");
        sent.add(item.sourceText);
      }
      // Fixed 80ms request overhead + 0.12ms per input character stands in
      // for generation time proportional to the amount of translated text.
      const chars = message.items.reduce((total, item) => total + (item.formattedText || item.sourceText).length, 0);
      await new Promise((resolve) => setTimeout(resolve, 80 + chars * 0.12));
      active -= 1;
      return { ok: true, items: message.items.map((item) => {
        const translatedText = `译文：${item.sourceText}`;
        cache.set(item.sourceText, translatedText);
        return { id: item.id, translatedText };
      }) };
    } };
    window.eval(source);
    const ball = window.document.querySelector(".ytbt-immersive-tab");
    const start = performance.now();
    const observer = new window.MutationObserver(() => {
      if (firstVisibleMs === undefined && window.document.querySelector("[data-ytbt-immersive-for='im0'][data-ytbt-state='done']")) {
        firstVisibleMs = performance.now() - start;
      }
    });
    observer.observe(window.document.body, { subtree: true, attributes: true });
    ball.click();
    while (ball.dataset.ytbtState === "translating") {
      if (performance.now() - start > 15000) throw new Error("Benchmark timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ball.dataset.ytbtState, "done");
    assert.equal(window.document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']").length, 16);
    observer.disconnect();
    return { firstVisibleMs: Math.round(firstVisibleMs), totalMs: Math.round(performance.now() - start), requests, peakConcurrency: peak };
  } finally {
    window.close();
  }
}

(async () => {
  const results = {};
  for (const [name, source] of Object.entries(sources)) {
    const cache = new Map();
    results[name] = { cold: await run(source, cache), cachedRestart: await run(source, cache) };
    assert.equal(results[name].cachedRestart.requests, 0);
    assert.ok(results[name].cold.peakConcurrency <= 3);
  }
  console.log(JSON.stringify({ simulation: "16 paragraphs; 1 visible; fake provider delay = 80ms + 0.12ms/source character", baseline, results }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
