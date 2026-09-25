const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../src/shared.js");

const root = path.resolve(__dirname, "..");
const OPTIONS_PAGE = path.join(root, "options/options.html");
const SUB_PAGES = ["translation-services", "realtime-api", "immersive-api", "general-settings"];

async function openSettings(t, { storage = {}, hash = "" } = {}) {
  const dom = new JSDOM(fs.readFileSync(OPTIONS_PAGE, "utf8"), {
    url: `https://example.com/options/options.html${hash}`,
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  const scrolls = [];
  dom.window.scrollTo = (options) => scrolls.push(options);
  dom.window.YTBTCore = Core;
  dom.window.chrome = { storage: { local: {
    get(defaults, callback) { callback({ ...defaults, ...storage }); },
    set(values, callback) { Object.assign(storage, values); callback(); },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      callback();
    }
  } } };
  dom.window.eval(fs.readFileSync(path.join(root, "options/options.js"), "utf8"));
  await Promise.resolve();
  const document = dom.window.document;
  return {
    window: dom.window,
    document,
    storage,
    scrolls,
    visiblePages: () => SUB_PAGES.filter((id) => !document.getElementById(id).hidden),
    selectedTabs: () => [...document.querySelectorAll('[role="tab"]')]
      .filter((tab) => tab.getAttribute("aria-selected") === "true")
      .map((tab) => tab.id)
  };
}

async function waitFor(predicate, timeout = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("options page shows exactly one sub-page and switches sub-pages by click", async (t) => {
  const page = await openSettings(t);
  assert.deepEqual(page.visiblePages(), ["translation-services"]);
  assert.deepEqual(page.selectedTabs(), ["tab-translation-services"]);
  assert.equal(page.window.location.hash, "");

  page.document.getElementById("tab-realtime-api").click();
  assert.deepEqual(page.visiblePages(), ["realtime-api"]);
  assert.deepEqual(page.selectedTabs(), ["tab-realtime-api"]);
  assert.equal(page.window.location.hash, "#realtime-api");

  page.document.getElementById("tab-general-settings").click();
  assert.deepEqual(page.visiblePages(), ["general-settings"]);
  assert.deepEqual(page.selectedTabs(), ["tab-general-settings"]);
  assert.equal(page.window.location.hash, "#general-settings");
  assert.equal(page.scrolls.length, 2, "each switch returns to the top of the layout");
});

test("the provider page links jump to the 翻译服务 sub-page", async (t) => {
  const page = await openSettings(t);
  page.document.getElementById("tab-realtime-api").click();
  const link = page.document.querySelector("[data-goto]");
  assert.ok(link, "the empty-service hint links to the provider page");
  link.click();
  assert.deepEqual(page.visiblePages(), ["translation-services"]);
  assert.equal(page.window.location.hash, "#translation-services");
});

test("hidden sub-pages keep their field values so one save still stores every page", async (t) => {
  const storage = {};
  const page = await openSettings(t, { storage });
  assert.equal(page.document.getElementById("immersive-api").hidden, true);
  page.document.getElementById("targetLanguage").value = "zh-TW";
  page.document.querySelector("form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await Promise.resolve();
  assert.equal(storage.immersiveFallbackProvider, undefined, "removed fallback setting stays cleared");
  assert.equal(storage.targetLanguage, "zh-TW");
});

test("sub-pages are deep-linkable and follow browser back and forward", async (t) => {
  const page = await openSettings(t, { hash: "#general-settings" });
  assert.deepEqual(page.visiblePages(), ["general-settings"]);
  assert.deepEqual(page.selectedTabs(), ["tab-general-settings"]);

  page.document.getElementById("tab-realtime-api").click();
  assert.equal(page.window.location.hash, "#realtime-api");

  page.window.history.back();
  await waitFor(() => page.window.location.hash === "#general-settings");
  assert.equal(page.window.location.hash, "#general-settings");
  assert.deepEqual(page.visiblePages(), ["general-settings"]);

  page.window.history.forward();
  await waitFor(() => page.window.location.hash === "#realtime-api");
  assert.equal(page.window.location.hash, "#realtime-api");
  assert.deepEqual(page.visiblePages(), ["realtime-api"]);
});

test("an unknown hash falls back to the first sub-page", async (t) => {
  const page = await openSettings(t, { hash: "#nope" });
  assert.deepEqual(page.visiblePages(), ["translation-services"]);
  assert.deepEqual(page.selectedTabs(), ["tab-translation-services"]);
});

test("arrow keys move between sub-pages and the page title follows", async (t) => {
  const page = await openSettings(t);
  const tab = page.document.getElementById("tab-translation-services");
  tab.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  assert.deepEqual(page.visiblePages(), ["realtime-api"]);
  assert.equal(page.document.activeElement.id, "tab-realtime-api");
  assert.equal(page.document.title, "实时字幕 · AuraTranslate 设置");
  page.document.getElementById("tab-realtime-api")
    .dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
  assert.deepEqual(page.visiblePages(), ["general-settings"]);
});

test("services show one sub-page panel each and no entry scrolls to a stacked section", () => {
  const document = new JSDOM(fs.readFileSync(OPTIONS_PAGE, "utf8")).window.document;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  assert.equal(tabs.length, SUB_PAGES.length);
  assert.equal(panels.length, SUB_PAGES.length);
  assert.deepEqual(panels.map((panel) => panel.id), SUB_PAGES);
  assert.equal(panels.filter((panel) => !panel.hasAttribute("hidden")).length, 1);

  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    assert.ok(panel, `${tab.id} controls an existing sub-page`);
    assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
    assert.equal(tab.getAttribute("type"), "button");
  }

  const fields = [...document.querySelectorAll("#settings-form input[id], #settings-form select[id]")];
  assert.ok(fields.length > 10, "the settings form keeps all of its fields");
  for (const field of fields) {
    const owners = panels.filter((panel) => panel.contains(field));
    assert.equal(owners.length, 1, `${field.id} belongs to exactly one sub-page`);
  }

  const dialog = document.getElementById("service-dialog");
  assert.ok(dialog, "the provider dialog exists");
  assert.equal(dialog.closest("form"), null, "dialog inputs must not submit with the settings form");

  assert.equal(document.querySelectorAll(".sidebar-nav a").length, 0, "sub-page entries are not anchor links");
  const css = fs.readFileSync(path.join(root, "options/options.css"), "utf8");
  assert.doesNotMatch(css, /scroll-behavior:\s*smooth/);
  assert.match(css, /\.settings-section\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, "the single mobile column must be allowed to shrink");
  assert.match(css, /overflow-x:\s*auto/, "sub-page entries stay reachable in a swipeable strip");
});
