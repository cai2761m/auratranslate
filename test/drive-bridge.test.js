const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../src/shared.js");

function makeTranscriptEntry(startMs, timeLabel, sourceText) {
  const timestamp = String(startMs);
  return {
    children: [
      {
        tagName: "DIV",
        textContent: timeLabel,
        getAttribute(name) {
          return name === "data-timestamp" ? timestamp : null;
        }
      },
      {
        tagName: "DIV",
        textContent: sourceText,
        getAttribute(name) {
          return name === "data-timestamp" ? timestamp : null;
        }
      }
    ],
    getAttribute(name) {
      return name === "data-timestamp" ? timestamp : null;
    },
    closest() {
      return null;
    }
  };
}

test("Drive bridge sends timestamped transcript cues to the embedded player", () => {
  const postedMessages = [];
  const contentWindow = {
    postMessage(message, origin) {
      postedMessages.push({ message, origin });
    }
  };
  const frame = {
    src: "https://youtube.googleapis.com/embed/?ps=docs",
    contentWindow,
    getBoundingClientRect() {
      return {
        left: 300,
        top: 100,
        right: 1100,
        bottom: 550,
        width: 800,
        height: 450
      };
    }
  };
  const entries = [
    makeTranscriptEntry(640, "0:01", "First cue"),
    makeTranscriptEntry(3919, "0:04", "Second cue")
  ];
  const listeners = new Map();
  const document = {
    documentElement: {},
    body: {},
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "iframe") {
        return [frame];
      }
      if (selector === 'div[role="button"][data-timestamp]') {
        return entries;
      }
      if (selector === "button[aria-label]") {
        return [];
      }
      return [];
    }
  };
  const window = {
    location: {
      href: "https://drive.google.com/file/d/file-123/view",
      pathname: "/file/d/file-123/view"
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };

  const source = fs.readFileSync(path.join(__dirname, "../src/drive.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    clearTimeout,
    decodeURIComponent,
    document,
    globalThis: { YTBTCore: Core },
    MutationObserver: class {},
    setInterval() {},
    setTimeout,
    window
  });

  const transcriptMessage = postedMessages.find(
    ({ message }) => message.type === "DRIVE_TRANSCRIPT"
  );
  assert.ok(transcriptMessage);
  assert.equal(transcriptMessage.origin, "https://youtube.googleapis.com");
  assert.equal(transcriptMessage.message.fileId, "file-123");
  assert.deepEqual(
    JSON.parse(JSON.stringify(transcriptMessage.message.cues)),
    [
      { startMs: 640, endMs: 3919, sourceText: "First cue" },
      { startMs: 3919, endMs: 8919, sourceText: "Second cue" }
    ]
  );

  postedMessages.length = 0;
  listeners.get("message")({
    origin: "https://youtube.googleapis.com",
    source: contentWindow,
    data: {
      channel: "__ytbt_drive_transcript__",
      type: "REQUEST_DRIVE_TRANSCRIPT"
    }
  });
  assert.equal(postedMessages[0].message.type, "DRIVE_TRANSCRIPT");

  postedMessages.length = 0;
  listeners.get("message")({
    origin: "https://youtube.googleapis.com",
    source: contentWindow,
    data: {
      channel: "__ytbt_drive_transcript__",
      type: "DRIVE_OVERLAY_GEOMETRY",
      version: "0.2.3",
      rects: [{ x: 100, y: 20, width: 200, height: 80 }]
    }
  });

  const capturedPointers = new Set();
  const captureTarget = {
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
  const eventFlags = [];
  const pointerEvent = (type, clientX, clientY) => ({
    type,
    pointerType: "mouse",
    button: 0,
    pointerId: 9,
    clientX,
    clientY,
    target: captureTarget,
    preventDefault() {
      eventFlags.push(`${type}:prevented`);
    },
    stopImmediatePropagation() {
      eventFlags.push(`${type}:stopped`);
    }
  });

  listeners.get("pointerdown")(pointerEvent("down", 450, 150));
  listeners.get("pointermove")(pointerEvent("move", 500, 300));
  listeners.get("pointerup")(pointerEvent("up", 500, 300));

  assert.deepEqual(
    postedMessages.map(({ message }) => ({
      type: message.type,
      pointerId: message.pointerId,
      clientX: message.clientX,
      clientY: message.clientY
    })),
    [
      {
        type: "DRIVE_OVERLAY_POINTER_DOWN",
        pointerId: 9,
        clientX: 150,
        clientY: 50
      },
      {
        type: "DRIVE_OVERLAY_POINTER_MOVE",
        pointerId: 9,
        clientX: 200,
        clientY: 200
      },
      {
        type: "DRIVE_OVERLAY_POINTER_UP",
        pointerId: 9,
        clientX: 200,
        clientY: 200
      }
    ]
  );
  assert.equal(capturedPointers.has(9), false);
  assert.deepEqual(eventFlags, [
    "down:prevented",
    "down:stopped",
    "move:prevented",
    "move:stopped",
    "up:prevented",
    "up:stopped"
  ]);
});
