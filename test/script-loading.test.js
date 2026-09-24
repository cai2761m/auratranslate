const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const Core = require("../src/shared.js");
const { files } = require("../scripts/extension-scripts.cjs");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("every content script and extension page loads the complete shared API in order", () => {
  const expected = files("shared");
  const entries = manifest.content_scripts.map(entry => entry.js);
  for (const page of ["options/options.html", "popup/popup.html"]) {
    const scripts = [...read(page).matchAll(/<script\s+src="([^"]+)"/g)]
      .map(match => path.posix.normalize(path.posix.join(path.posix.dirname(page), match[1])));
    entries.push(scripts);
  }
  for (const scripts of entries) {
    assert.deepEqual(scripts.slice(0, expected.length), expected);
    for (const file of scripts) assert.ok(fs.existsSync(path.join(root, file)), file);
    const context = vm.createContext({});
    for (const file of scripts.slice(0, expected.length)) vm.runInContext(read(file), context, { filename: file });
    assert.deepEqual(Object.keys(context.YTBTCore), Object.keys(Core));
    assert.ok(Object.values(context.YTBTCore).every(value => value !== undefined));
    const result = context.YTBTCore.parseDeepSeekTranslationContent('{"items":[{"id":"1","translatedText":"你好"}]}');
    assert.equal(result[0].translatedText, "你好");
    assert.equal(context.YTBTCore.resolveTranslationConfig({}).model, Core.resolveTranslationConfig({}).model);
  }
});

test("webpage modules coexist with subtitle globals and repeated injection keeps one controller", async t => {
  const dom = new JSDOM("<main><p>A readable paragraph for the page.</p></main>", {
    url: "https://www.youtube.com/watch?v=module-test", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  let receivers = 0;
  let settingsListeners = 0;
  let intervals = 0;
  window.chrome = {
    runtime: { onMessage: { addListener() { receivers++; } } },
    storage: {
      local: { get(defaults, callback) { callback(defaults); }, set(_values, callback) { callback(); } },
      onChanged: { addListener() { settingsListeners++; } }
    }
  };
  window.setInterval = () => ++intervals;
  window.eval("var Core = 'subtitle-core'; var state = { subtitle: true }; var BATCH_SIZE = 30; function translateBatch() { return 'subtitle'; }");
  const scripts = manifest.content_scripts.find(entry => entry.js.includes("src/immersive.js")).js;
  for (const file of scripts) window.eval(read(file));
  const pageState = window.YTBTImmersive.state;
  for (const file of scripts) window.eval(read(file));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.Core, "subtitle-core");
  assert.equal(window.state.subtitle, true);
  assert.equal(window.BATCH_SIZE, 30);
  assert.equal(window.translateBatch(), "subtitle");
  assert.equal(window.YTBTImmersive.state, pageState);
  assert.equal(window.document.querySelectorAll(".ytbt-immersive-tab").length, 1);
  assert.equal(receivers, 1);
  assert.equal(settingsListeners, 1);
  assert.equal(intervals, 1);
});
