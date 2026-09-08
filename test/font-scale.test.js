const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../src/shared.js");

test("font scale accepts smaller mobile sizes, finer steps, and larger sizes", () => {
  for (const scale of [0.3, 0.35, 0.5, 0.65, 0.7, 1, 1.8, 2, 3]) {
    assert.equal(Core.normalizeFontScale(scale), scale);
    assert.equal(Core.normalizeFontScale(String(scale)), scale);
  }
  assert.equal(Core.normalizeFontScale(-1), 0.3);
  assert.equal(Core.normalizeFontScale(4), 3);
  for (const invalid of [undefined, null, "", "invalid", NaN, Infinity, true]) {
    assert.equal(Core.normalizeFontScale(invalid), 1);
  }
});

async function optionsPage(storage) {
  const elements = new Map();
  for (const id of ["settings-form", "fontScale", "fontScaleValue", "status"]) {
    elements.set(`#${id}`, {
      value: "", textContent: "", listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
  }
  const context = vm.createContext({
    YTBTCore: Core,
    document: { querySelector(selector) { return elements.get(selector) || null; } },
    chrome: { storage: { local: {
      get(defaults, callback) { callback({ ...defaults, ...storage }); },
      set(values, callback) { Object.assign(storage, values); callback(); }
    } } },
    setTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../options/options.js"), "utf8"), context);
  await Promise.resolve();
  return Object.fromEntries([...elements].map(([key, value]) => [key.slice(1), value]));
}

test("settings slider saves and reloads fine-grained mobile sizes without rounding", async () => {
  const storage = { fontScale: 0.7 };
  const page = await optionsPage(storage);
  assert.equal(page.fontScale.min, "0.3");
  assert.equal(page.fontScale.max, "3");
  assert.equal(page.fontScale.step, "0.05");
  assert.equal(Number(page.fontScale.value), 0.7, "keep the user's previous setting");
  for (const scale of [0.3, 0.55, 0.65, 3]) {
    page.fontScale.value = String(scale);
    page.fontScale.listeners.input();
    assert.equal(page.fontScaleValue.textContent, `${scale.toFixed(2)}x`);
    await page["settings-form"].listeners.submit({ preventDefault() {} });
    assert.equal(storage.fontScale, scale);
    const reopened = await optionsPage(storage);
    assert.equal(Number(reopened.fontScale.value), scale);
    assert.equal(reopened.fontScaleValue.textContent, `${scale.toFixed(2)}x`);
  }
});

test("HTML slider bounds match shared validation and its hint is accessible", () => {
  const html = fs.readFileSync(path.join(__dirname, "../options/options.html"), "utf8");
  const input = html.match(/<input id="fontScale"[^>]+>/)[0];
  for (const [name, value] of [["min", Core.FONT_SCALE_MIN], ["max", Core.FONT_SCALE_MAX], ["step", Core.FONT_SCALE_STEP]]) {
    assert.ok(input.includes(`${name}="${value}"`));
  }
  assert.match(input, /aria-describedby="fontScaleHint"/);
  assert.match(html, /id="fontScaleHint"/);
});
