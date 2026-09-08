const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");

function createDragHarness({ mobile = false } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const windowListenerOptions = new Map();
  const savedSettings = {};
  let saveCount = 0;
  const document = {
    documentElement: { classList: { toggle() {} } },
    querySelectorAll() { return []; },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) {
        documentListeners.delete(type);
      }
    },
    querySelector(selector) {
      return selector === ".html5-video-player" ? player : null;
    }
  };
  const player = {
    appendChild(node) {
      node.parentElement = player;
    },
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
    style: { display: "inline-block", visibility: "visible" },
    getBoundingClientRect() {
      return overlay.getBoundingClientRect();
    },
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
    isConnected: true,
    dataset: {},
    parentElement: player,
    style: {
      setProperty(name, value) { this[name] = value; }
    },
    classList: {
      toggle(name, enabled) {
        if (enabled) classNames.add(name);
        else classNames.delete(name);
      },
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
    contains(node) {
      return node === surface;
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
          saveCount += 1;
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
      ...(mobile ? { ontouchstart: null } : {}),
      addEventListener(type, listener, options) {
        windowListeners.set(type, listener);
        windowListenerOptions.set(type, options);
      },
      removeEventListener(type, listener) {
        if (windowListeners.get(type) === listener) windowListeners.delete(type);
      },
      getComputedStyle(node) { return node.style; },
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
      "    normalizeSettings, applySettings,",
      "    bindOverlayDragHandlers,",
      "    ensureOverlay,",
      "    applyOverlayPosition,",
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

  return {
    api, overlay, surface, player, savedSettings, documentListeners, windowListeners,
    windowListenerOptions, overlayListeners, surfaceListeners, capturedPointers, classNames,
    get saveCount() { return saveCount; }
  };
}

test("subtitle overlay applies the expanded font scale to its CSS variable", () => {
  const { api, overlay } = createDragHarness({ mobile: true });
  for (const scale of [0.3, 0.55, 0.65, 3]) {
    api.state.settings = api.normalizeSettings({ fontScale: scale });
    api.applySettings();
    assert.equal(overlay.style["--ytbt-font-scale"], String(scale));
  }
});

test("subtitle overlay starts dragging immediately and saves its position", () => {
  const {
    api, overlay, surface, savedSettings, documentListeners,
    overlayListeners, surfaceListeners, capturedPointers, classNames
  } = createDragHarness();

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

function touchEvent(touches, changedTouches = touches) {
  return {
    // The player control layer receives the touch, not a subtitle child.
    target: { closest() { return null; } },
    touches, changedTouches, cancelable: true, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
}

test("Android touches through the player layer drag subtitles and persist on release", () => {
  const h = createDragHarness({ mobile: true });
  const { api, overlay, windowListeners, windowListenerOptions, surfaceListeners } = h;
  surfaceListeners.get("pointerdown")({ pointerType: "touch", pointerId: 7 });
  assert.equal(api.state.overlayDrag.active, false, "one finger must not start two drag streams");

  const start = touchEvent([{ identifier: 0, clientX: 150, clientY: 120 }]);
  windowListeners.get("touchstart")(start);
  assert.ok(start.prevented && start.stopped, "player swipe/scroll handlers must not receive this touch");
  assert.equal(api.state.overlayDrag.touchId, 0);
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    assert.equal(windowListenerOptions.get(type).capture, true);
    assert.equal(windowListenerOptions.get(type).passive, false);
  }
  const move = touchEvent([{ identifier: 0, clientX: 300, clientY: 300 }]);
  windowListeners.get("touchmove")(move);
  assert.ok(move.prevented && move.stopped);
  assert.equal(overlay.style.left, "43.75%");
  assert.equal(overlay.style.top, "53.333333333333336%");

  // A second finger must neither take over nor end the first finger's drag.
  windowListeners.get("touchstart")(touchEvent([
    ...move.touches, { identifier: 9, clientX: 170, clientY: 140 }
  ]));
  windowListeners.get("touchend")(touchEvent(move.touches, [{ identifier: 9, clientX: 170, clientY: 140 }]));
  assert.equal(api.state.overlayDrag.touchId, 0);
  assert.equal(h.saveCount, 0);

  const end = touchEvent([], [{ identifier: 0, clientX: 400, clientY: 400 }]);
  windowListeners.get("touchend")(end);
  assert.ok(end.prevented && end.stopped);
  assert.equal(h.savedSettings.subtitlePosition.xPct, 56.25, "use the final touch coordinates");
  assert.equal(h.savedSettings.subtitlePosition.yPct, 70);
  assert.equal(h.saveCount, 1);
  assert.equal(api.state.overlayDrag.touchId, null);
  assert.equal(api.state.overlayDrag.active, false);
  for (const type of ["touchmove", "touchend", "touchcancel"]) assert.equal(windowListeners.has(type), false);
});

test("portrait and landscape touch drags stay inside the video and restore the saved position", () => {
  const h = createDragHarness({ mobile: true });
  let playerRect = { left: 0, top: 60, right: 360, bottom: 280, width: 360, height: 220 };
  let overlayRect = { left: 50, top: 170, right: 310, bottom: 230, width: 260, height: 60 };
  h.player.getBoundingClientRect = () => playerRect;
  h.overlay.getBoundingClientRect = () => overlayRect;
  h.windowListeners.get("touchstart")(touchEvent([{ identifier: 1, clientX: 100, clientY: 200 }]));
  h.windowListeners.get("touchmove")(touchEvent([{ identifier: 1, clientX: 100, clientY: 100 }]));
  assert.equal(h.overlay.style.top, `${42 / 220 * 100}%`);
  h.windowListeners.get("touchend")(touchEvent([], [{ identifier: 1, clientX: 100, clientY: 100 }]));
  assert.equal(h.savedSettings.subtitlePosition.yPct, 42 / 220 * 100);

  playerRect = { left: 0, top: 0, right: 800, bottom: 360, width: 800, height: 360 };
  overlayRect = { left: 100, top: 100, right: 500, bottom: 180, width: 400, height: 80 };
  h.api.applyOverlayPosition();
  assert.equal(h.overlay.style.top, `${42 / 220 * 100}%`, "rotation retains the relative saved position");
  h.windowListeners.get("touchstart")(touchEvent([{ identifier: 2, clientX: 150, clientY: 120 }]));
  h.windowListeners.get("touchend")(touchEvent([], [{ identifier: 2, clientX: 500, clientY: 900 }]));
  assert.equal(h.savedSettings.subtitlePosition.yPct, 308 / 360 * 100, "dragging beyond the video clamps to the lower edge");
  const restored = createDragHarness({ mobile: true });
  restored.api.state.settings.subtitlePosition = h.savedSettings.subtitlePosition;
  restored.api.applyOverlayPosition();
  assert.equal(restored.overlay.style.top, h.overlay.style.top);
  assert.equal(restored.overlay.style.left, h.overlay.style.left);
});

test("touches outside subtitles, on hidden subtitles or with two initial fingers remain player gestures", () => {
  const h = createDragHarness({ mobile: true });
  const start = h.windowListeners.get("touchstart");
  const onSubtitle = [{ identifier: 1, clientX: 150, clientY: 120 }];
  const outside = touchEvent([{ identifier: 1, clientX: 600, clientY: 500 }]);
  start(outside);
  assert.equal(outside.prevented, false);
  for (const visible of [false, true]) {
    h.overlay.hidden = !visible;
    h.surface.style.display = visible ? "none" : "inline-block";
    const event = touchEvent(onSubtitle);
    start(event);
    assert.equal(event.prevented, false);
  }
  h.surface.style.display = "inline-block";
  const pinch = touchEvent([...onSubtitle, { identifier: 2, clientX: 200, clientY: 120 }]);
  start(pinch);
  assert.equal(pinch.prevented, false);
  assert.equal(h.api.state.overlayDrag.active, false);
  assert.equal(h.saveCount, 0);
});

test("touch cancellation releases the drag and long press does not open a player menu", () => {
  const h = createDragHarness({ mobile: true });
  const fingers = [{ identifier: 4, clientX: 150, clientY: 120 }];
  h.windowListeners.get("touchstart")(touchEvent(fingers));
  const menu = touchEvent([]);
  h.windowListeners.get("contextmenu")(menu);
  assert.ok(menu.prevented && menu.stopped);
  h.windowListeners.get("touchcancel")(touchEvent([], fingers));
  assert.equal(h.api.state.overlayDrag.active, false);
  assert.equal(h.saveCount, 0, "cancelled gestures must not persist an accidental position");
  const next = touchEvent(fingers);
  h.windowListeners.get("touchstart")(next);
  assert.equal(h.api.state.overlayDrag.touchId, 4, "a new gesture works after cancellation");
});

test("switching player containers preserves subtitle nodes and drag listeners", () => {
  const h = createDragHarness();
  const oldParts = { cn: {}, en: {}, status: {} };
  h.api.state.overlayParts = oldParts;
  h.api.state.settings.subtitleEnabled = false; // avoid unrelated native-caption sweeps
  h.overlay.parentElement = {};
  h.api.ensureOverlay();
  assert.equal(h.overlay.parentElement, h.player);
  assert.equal(h.api.state.overlayParts, oldParts);
  assert.equal(h.overlay.innerHTML, undefined, "reparenting must not replace bound children");
  assert.ok(h.surfaceListeners.has("pointerdown"));
  assert.ok(h.windowListeners.has("touchstart"));
  assert.equal(h.overlay.style.bottom, "", "CSS must control the mobile default offset");
});
