// Use production script order in tests and local benchmarks.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function files(kind) {
  if (kind === "shared") return manifest.background.scripts.filter(file => /\/shared(?:-|\.)/.test(file));
  if (kind === "immersive") return manifest.content_scripts.find(entry => entry.js.includes("src/immersive.js"))
    .js.filter(file => /\/immersive(?:-|\.)/.test(file));
  throw new Error(`Unknown script group: ${kind}`);
}

function source(kind) {
  return files(kind).map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n;\n");
}

function loadBackground(context, mode = "worker") {
  const run = file => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  if (mode === "worker") {
    context.importScripts = (...names) => names.forEach(name => run(`src/${name}`));
    run(manifest.background.service_worker);
  } else if (mode === "event-page") {
    delete context.importScripts;
    manifest.background.scripts.forEach(run);
  } else throw new Error(`Unknown background mode: ${mode}`);
}

module.exports = { files, source, loadBackground };
