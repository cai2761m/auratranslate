const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

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
