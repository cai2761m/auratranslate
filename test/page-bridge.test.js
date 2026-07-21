const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("page bridge resends an unchanged player response when the content script requests it", () => {
  const listeners = new Map();
  const postedMessages = [];
  const window = {
    location: { origin: "https://www.youtube.com" },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-1", title: "Test video" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=en",
              languageCode: "en",
              name: { simpleText: "English" }
            }
          ]
        }
      }
    },
    ytcfg: {
      get(name) {
        if (name === "INNERTUBE_API_KEY") {
          return "test-key";
        }
        return undefined;
      }
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      postedMessages.push(message);
    }
  };
  const document = {
    addEventListener() {},
    querySelector() {
      return null;
    }
  };

  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  vm.runInNewContext(source, {
    document,
    window,
    setInterval() {},
    setTimeout(callback) {
      callback();
    }
  });

  assert.equal(postedMessages.length, 1);
  listeners.get("message")({
    source: window,
    origin: window.location.origin,
    data: {
      channel: "__ytbt_player_response__",
      type: "REQUEST_PLAYER_RESPONSE"
    }
  });

  assert.equal(postedMessages.length, 2);
  assert.deepEqual(postedMessages[1].captionTracks, postedMessages[0].captionTracks);
  assert.equal(postedMessages[1].transcript.apiKey, "test-key");
});
