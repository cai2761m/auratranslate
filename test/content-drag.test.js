const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");

test("subtitle overlay starts dragging immediately and saves its position", () => {
  const documentListeners = new Map();
  const savedSettings = {};
  const document = {
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) {
        documentListeners.delete(type);
      }
    },
    querySelector() {
      return null;
    }
  };
  const player = {
    closest() {
      return player;
    },
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600
      };
    }
  };
  const classNames = new Set();
  const overlayListeners = new Map();
  const surfaceListeners = new Map();
  const capturedPointers = new Set();
  const surface = {
    addEventListener(type, listener) {
      surfaceListeners.set(type, listener);
    },
    setPointerCapture(pointerId) {
      capturedPointers.add(pointerId);
    },
    hasPointerCapture(pointerId) {
      return capturedPointers.has(pointerId);
    },
    releasePointerCapture(pointerId) {
      capturedPointers.delete(pointerId);
    }
  };
  const overlay = {
    dataset: {},
    parentElement: player,
    style: {
      setProperty() {}
    },
    classList: {
      add(name) {
        classNames.add(name);
      },
      remove(name) {
        classNames.delete(name);
      }
    },
    addEventListener(type, listener) {
      overlayListeners.set(type, listener);
    },
    querySelectorAll() {
      return [surface];
    },
    getBoundingClientRect() {
      return {
        left: 100,
        top: 100,
        right: 300,
        bottom: 180,
        width: 200,
        height: 80
      };
    }
  };
  const chrome = {
    storage: {
      local: {
        get(defaults, callback) {
          callback(defaults);
        },
        set(values, callback) {
          Object.assign(savedSettings, values);
          callback();
        }
      }
    }
  };
  const context = vm.createContext({
    chrome,
    clearInterval,
    clearTimeout,
    console,
    document,
    requestAnimationFrame() {},
    setInterval,
    setTimeout,
    window: {
      location: {
        hostname: "youtube.googleapis.com",
        pathname: "/embed/"
      }
    },
    YTBTCore: Core
  });

  let source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  source = source.replace("\n  init();", "\n  // Initialization is omitted by this isolated interaction test.");
  source = source.replace(
    /\n\}\)\(\);\s*$/,
    [
      "",
      "  globalThis.__YTBTDragTest = {",
      "    state,",
      "    bindOverlayDragHandlers,",
      "    beginRelayedOverlayDrag,",
      "    moveRelayedOverlayDrag,",
      "    endRelayedOverlayDrag",
      "  };",
      "})();"
    ].join("\n")
  );
  vm.runInContext(source, context);

  const api = context.__YTBTDragTest;
  api.state.overlay = overlay;
  api.bindOverlayDragHandlers(overlay);

  assert.equal(overlayListeners.has("pointerdown"), false);
  assert.equal(surfaceListeners.has("pointerdown"), true);

  const pointerDown = surfaceListeners.get("pointerdown");
  const eventFlags = { prevented: false, stopped: false };
  pointerDown({
    pointerType: "mouse",
    button: 0,
    pointerId: 7,
    clientX: 150,
    clientY: 120,
    currentTarget: surface,
    target: {
      closest() {
        return surface;
      }
    },
    preventDefault() {
      eventFlags.prevented = true;
    },
    stopPropagation() {
      eventFlags.stopped = true;
    }
  });

  assert.equal(api.state.overlayDrag.active, true);
  assert.equal(capturedPointers.has(7), true);
  assert.equal(classNames.has("ytbt-dragging"), true);
  assert.deepEqual(eventFlags, { prevented: true, stopped: true });

  documentListeners.get("pointermove")({
    pointerId: 7,
    clientX: 300,
    clientY: 300,
    preventDefault() {},
    stopPropagation() {}
  });

  assert.equal(overlay.style.left, "43.75%");
  assert.equal(overlay.style.top, "53.333333333333336%");

  documentListeners.get("pointerup")({
    pointerId: 7,
    preventDefault() {},
    stopPropagation() {}
  });

  assert.equal(savedSettings.subtitlePosition.xPct, 43.75);
  assert.equal(savedSettings.subtitlePosition.yPct, 53.333333333333336);
  assert.equal(api.state.overlayDrag.pointerId, null);
  assert.equal(capturedPointers.has(7), false);
  assert.equal(classNames.has("ytbt-dragging"), false);

  api.beginRelayedOverlayDrag({
    pointerId: 11,
    clientX: 150,
    clientY: 120
  });
  api.moveRelayedOverlayDrag({
    pointerId: 11,
    clientX: 400,
    clientY: 400
  });
  api.endRelayedOverlayDrag({
    pointerId: 11,
    clientX: 400,
    clientY: 400
  }, true);

  assert.equal(savedSettings.subtitlePosition.xPct, 56.25);
  assert.equal(savedSettings.subtitlePosition.yPct, 70);
  assert.equal(api.state.overlayDrag.pointerId, null);
});
