const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

for (const mode of ["Firefox event page", "Chrome service worker"]) {
  test(`${mode} registers its receiver on fresh starts using manifest scripts`, async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    // Two independent globals model an unloaded background starting again.
    for (let start = 0; start < 2; start++) {
      let listener;
      const context = vm.createContext({
        chrome: {
          runtime: { onMessage: { addListener(fn) { listener = fn; } } },
          storage: { local: { get(defaults, callback) { callback(defaults); } } }
        },
        fetch() { assert.fail("Empty segmentation must not call a paid API"); }
      });
      const run = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
      if (mode === "Firefox event page") {
        for (const script of manifest.background.scripts) run(script);
      } else {
        context.importScripts = (file) => run(`src/${file}`);
        run(manifest.background.service_worker);
      }
      assert.equal(typeof listener, "function", "registration must be synchronous");
      const response = await new Promise((resolve) => {
        assert.equal(listener({ type: "SEGMENT_SUBTITLES", cues: [] }, {}, resolve), true);
      });
      assert.equal(response.ok, true);
      assert.equal(response.type, "SEGMENT_SUBTITLES_RESULT");
    }
  });
}

test("manifest includes the Firefox for Android compatibility surface", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const youtubeMatches = manifest.content_scripts
    .flatMap((entry) => entry.matches || [])
    .filter((match) => match.includes("youtube.com"));
  const resourceMatches = manifest.web_accessible_resources
    .flatMap((entry) => entry.matches || [])
    .filter((match) => match.includes("youtube.com"));

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.browser_specific_settings.gecko.id, "auratranslate@cai2761m.github.io");
  assert.deepEqual(
    manifest.browser_specific_settings.gecko.data_collection_permissions.required,
    ["websiteContent", "authenticationInfo"]
  );
  assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.ok(youtubeMatches.includes("https://m.youtube.com/*"));
  assert.ok(resourceMatches.includes("https://m.youtube.com/*"));
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.deepEqual(manifest.background.scripts, ["src/shared.js", "src/background.js"]);
  assert.equal(manifest.options_ui.page, "options/options.html");
});

test("mobile popup and subtitle styles do not force desktop dimensions", () => {
  const popupCss = fs.readFileSync(path.join(root, "popup/popup.css"), "utf8");
  const overlayCss = fs.readFileSync(path.join(root, "src/overlay.css"), "utf8");

  assert.match(popupCss, /width:\s*min\(420px,\s*calc\(100vw\s*-\s*24px\)\)/);
  assert.match(popupCss, /min-width:\s*280px/);
  assert.match(overlayCss, /@media\s*\(max-width:\s*600px\)/);
  assert.match(overlayCss, /safe-area-inset-bottom/);
});

test("background script only imports shared code in service-worker mode", () => {
  const background = fs.readFileSync(path.join(root, "src/background.js"), "utf8");
  assert.match(background, /typeof importScripts === "function"/);
  assert.match(background, /importScripts\("shared\.js"\)/);
});
