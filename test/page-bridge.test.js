const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("page bridge resends an unchanged player response when the content script requests it", () => {
  const listeners = new Map();
  const postedMessages = [];
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-1"
    },
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
    URL,
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

test("page bridge prefers the current player response after SPA navigation", () => {
  const postedMessages = [];
  const currentResponse = {
    videoDetails: { videoId: "video-2", title: "Second video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=video-2&lang=en",
            languageCode: "en",
            name: { simpleText: "English" }
          }
        ]
      }
    }
  };
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-2"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-1", title: "First video" }
    },
    addEventListener() {},
    postMessage(message) {
      postedMessages.push(message);
    }
  };
  const document = {
    addEventListener() {},
    querySelector(selector) {
      if (selector === "#movie_player") {
        return {
          getPlayerResponse() {
            return currentResponse;
          }
        };
      }
      return null;
    }
  };

  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    document,
    window,
    setInterval() {},
    setTimeout(callback) {
      callback();
    }
  });

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].videoId, "video-2");
  assert.equal(postedMessages[0].captionTracks[0].languageCode, "en");
});

test("page bridge reuses the player timedtext URL containing YouTube's proof token", () => {
  const postedMessages = [];
  const staticUrl =
    "https://www.youtube.com/api/timedtext?v=video-asr&caps=asr&kind=asr&lang=en";
  const playerUrl =
    staticUrl +
    "&potc=1&pot=proof-token&fmt=json3&c=WEB&cver=2.20260727.01.00";
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-asr"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-asr", title: "Automatic captions" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: staticUrl,
              languageCode: "en",
              kind: "asr",
              vssId: "a.en",
              name: { simpleText: "English (auto-generated)" }
            }
          ]
        }
      }
    },
    addEventListener() {},
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
  const performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        { name: staticUrl + "&fmt=json3&c=WEB" },
        { name: playerUrl }
      ];
    }
  };

  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    document,
    performance,
    window,
    setInterval() {},
    setTimeout(callback) {
      callback();
    }
  });

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].captionTracks[0].baseUrl, playerUrl);
  assert.equal(postedMessages[0].captionTracks[0].kind, "asr");
});
