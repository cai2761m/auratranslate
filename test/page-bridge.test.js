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

test("page bridge captures a fetch timedtext body without consuming the page response", async () => {
  const listeners = new Map();
  const postedMessages = [];
  const captionText = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Hello" }] }] });
  const capturedUrl =
    "https://www.youtube.com/api/timedtext?v=video-fetch&lang=en&kind=asr&pot=fresh-proof&fmt=json3";
  const originalFetch = () => Promise.resolve(new Response(captionText, {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-fetch"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-fetch", title: "Fetch captions" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=video-fetch&lang=en&kind=asr",
              languageCode: "en",
              kind: "asr",
              vssId: "a.en",
              name: { simpleText: "English" }
            }
          ]
        }
      }
    },
    fetch: originalFetch,
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

  assert.notEqual(window.fetch, originalFetch);
  const pageResponse = await window.fetch(capturedUrl);
  assert.equal(await pageResponse.text(), captionText);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(postedMessages.length, 2);
  const capturedTrack = postedMessages[1].captionTracks[0];
  assert.equal(capturedTrack.baseUrl, capturedUrl);
  assert.equal(capturedTrack.capturedText, captionText);
});

test("page bridge captures successful XHR timedtext text without changing responseText", () => {
  const postedMessages = [];
  const captionText = "<?xml version=\"1.0\"?><transcript><text start=\"0\">Hello</text></transcript>";
  const capturedUrl =
    "https://www.youtube.com/api/timedtext?v=video-xhr&lang=en&pot=xhr-proof";

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
      this.responseType = "";
      this.responseText = captionText;
      this.responseURL = "";
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    finish() {
      for (const listener of this.listeners.get("loadend") || []) {
        listener();
      }
    }
  }

  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-xhr"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-xhr", title: "XHR captions" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=video-xhr&lang=en",
              languageCode: "en",
              name: { simpleText: "English" }
            }
          ]
        }
      }
    },
    XMLHttpRequest: FakeXMLHttpRequest,
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

  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", capturedUrl);
  xhr.finish();

  assert.equal(xhr.responseText, captionText);
  assert.equal(postedMessages.length, 2);
  assert.equal(postedMessages[1].captionTracks[0].baseUrl, capturedUrl);
  assert.equal(postedMessages[1].captionTracks[0].capturedText, captionText);
});

test("page bridge ignores translated, failed, and wrong-video timedtext fetches", async () => {
  const postedMessages = [];
  const responses = [];
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-filter"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-filter", title: "Filtered captions" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=video-filter&lang=en",
              languageCode: "en",
              name: { simpleText: "English" }
            }
          ]
        }
      }
    },
    fetch(url) {
      const response = new Response("must not be captured", {
        status: String(url).includes("failed=1") ? 500 : 200
      });
      responses.push(response);
      return Promise.resolve(response);
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

  await window.fetch("https://www.youtube.com/api/timedtext?v=video-filter&lang=en&tlang=zh-Hans");
  await window.fetch("https://www.youtube.com/api/timedtext?v=another-video&lang=en");
  await window.fetch("https://www.youtube.com/api/timedtext?v=video-filter&lang=en&failed=1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].captionTracks[0].capturedText, undefined);
  assert.equal(await responses[0].text(), "must not be captured");
});

test("page bridge triggers the requested native track and restores captions after capture", async () => {
  const listeners = new Map();
  const postedMessages = [];
  const timers = new Map();
  let nextTimerId = 1;
  let subtitlesOn = false;
  let toggleCalls = 0;
  let currentTrack = null;
  const selectedTrack = { languageCode: "en", kind: "asr", vssId: "a.en", id: "native-en" };
  const setOptionCalls = [];
  const player = {
    isSubtitlesOn() {
      return subtitlesOn;
    },
    toggleSubtitlesOn() {
      subtitlesOn = !subtitlesOn;
      toggleCalls += 1;
    },
    getOption(module, option) {
      assert.equal(module, "captions");
      if (option === "tracklist") {
        return [{ languageCode: "es", vssId: ".es" }, selectedTrack];
      }
      if (option === "track") {
        return currentTrack;
      }
      return null;
    },
    setOption(module, option, value) {
      setOptionCalls.push([module, option, value]);
      currentTrack = value;
    }
  };
  const captionText = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Native" }] }] });
  const capturedUrl =
    "https://www.youtube.com/api/timedtext?v=video-native&lang=en&kind=asr&pot=native-proof";
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-native"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-native", title: "Native captions" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=video-native&lang=en&kind=asr",
              languageCode: "en",
              kind: "asr",
              vssId: "a.en",
              name: { simpleText: "English" }
            }
          ]
        }
      }
    },
    fetch() {
      return Promise.resolve(new Response(captionText, { status: 200 }));
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
    querySelector(selector) {
      return selector === "#movie_player" ? player : null;
    }
  };

  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    document,
    window,
    setInterval() {},
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  });

  listeners.get("message")({
    source: window,
    origin: window.location.origin,
    data: {
      channel: "__ytbt_player_response__",
      type: "REQUEST_NATIVE_CAPTIONS",
      videoId: "video-native",
      track: {
        baseUrl: capturedUrl,
        languageCode: "en",
        kind: "asr",
        vssId: "a.en"
      }
    }
  });

  assert.equal(subtitlesOn, true);
  assert.equal(toggleCalls, 1);
  assert.equal(setOptionCalls.length, 1);
  assert.equal(setOptionCalls[0][2], selectedTrack);
  assert.equal([...timers.values()][0].delay, 6000);

  const pageResponse = await window.fetch(capturedUrl);
  assert.equal(await pageResponse.text(), captionText);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subtitlesOn, false);
  assert.equal(toggleCalls, 2);
  assert.equal(timers.size, 0);
  assert.equal(postedMessages.at(-1).captionTracks[0].capturedText, captionText);
});

test("page bridge restores an enabled native caption track after request timeout", () => {
  const listeners = new Map();
  const timers = [];
  let subtitlesOn = true;
  const originalTrack = { languageCode: "es", vssId: ".es" };
  const requestedTrack = { languageCode: "en", vssId: ".en" };
  let currentTrack = originalTrack;
  let toggleCalls = 0;
  const setTracks = [];
  const player = {
    isSubtitlesOn() {
      return subtitlesOn;
    },
    toggleSubtitlesOn() {
      subtitlesOn = !subtitlesOn;
      toggleCalls += 1;
    },
    getOption(module, option) {
      if (option === "track") {
        return currentTrack;
      }
      return option === "tracklist" ? [originalTrack, requestedTrack] : null;
    },
    setOption(module, option, value) {
      currentTrack = value;
      setTracks.push(value);
    }
  };
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-timeout"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-timeout" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: "https://www.youtube.com/api/timedtext?v=video-timeout&lang=en",
            languageCode: "en",
            vssId: ".en",
            name: { simpleText: "English" }
          }]
        }
      }
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage() {}
  };
  const document = {
    addEventListener() {},
    querySelector(selector) {
      return selector === "#movie_player" ? player : null;
    }
  };

  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    document,
    window,
    setInterval() {},
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {}
  });

  listeners.get("message")({
    source: window,
    origin: window.location.origin,
    data: {
      channel: "__ytbt_player_response__",
      type: "REQUEST_NATIVE_CAPTIONS",
      videoId: "video-timeout",
      track: requestedTrack
    }
  });
  assert.equal(currentTrack, requestedTrack);
  assert.equal(toggleCalls, 0);

  const timeout = timers.find((timer) => timer.delay === 6000);
  assert.ok(timeout);
  timeout.callback();

  assert.equal(currentTrack, originalTrack);
  assert.equal(subtitlesOn, true);
  assert.equal(toggleCalls, 0);
  assert.deepEqual(setTracks, [requestedTrack, originalTrack]);
});

test("page bridge expires captured URLs without reviving old Resource Timing entries", () => {
  const listeners = new Map();
  const postedMessages = [];
  let now = 1800000000000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const staticUrl = "https://www.youtube.com/api/timedtext?v=video-fresh&lang=en&kind=asr";
  const firstProofUrl = staticUrl + "&pot=first";
  const latestProofUrl = staticUrl + "&pot=latest";
  const expiredProofUrl = staticUrl + "&pot=expired&expire=1";
  const performance = {
    timeOrigin: now - 1000,
    getEntriesByType() {
      return [
        { name: firstProofUrl, startTime: 100, responseEnd: 200 },
        { name: latestProofUrl, startTime: 300, responseEnd: 400 },
        { name: expiredProofUrl, startTime: 500, responseEnd: 600 }
      ];
    }
  };
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-fresh"
    },
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-fresh" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: staticUrl,
            languageCode: "en",
            kind: "asr",
            vssId: "a.en",
            name: { simpleText: "English" }
          }]
        }
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
    Date: FakeDate,
    URL,
    document,
    performance,
    window,
    setInterval() {},
    setTimeout(callback) {
      callback();
    }
  });

  assert.equal(postedMessages[0].captionTracks[0].baseUrl, latestProofUrl);
  now += 2 * 60 * 1000 + 1;
  listeners.get("message")({
    source: window,
    origin: window.location.origin,
    data: {
      channel: "__ytbt_player_response__",
      type: "REQUEST_PLAYER_RESPONSE"
    }
  });

  assert.equal(postedMessages.at(-1).captionTracks[0].baseUrl, staticUrl);
});

test("page bridge does not reuse transcript params from the previous SPA video", () => {
  const listeners = new Map();
  const postedMessages = [];
  const initialData = {
    currentVideoEndpoint: { watchEndpoint: { videoId: "video-one" } },
    engagementPanels: [{ getTranscriptEndpoint: { params: "params-for-one" } }]
  };
  const window = {
    location: {
      origin: "https://www.youtube.com",
      href: "https://www.youtube.com/watch?v=video-one"
    },
    ytInitialData: initialData,
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-one" }
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
  assert.equal(postedMessages[0].transcript.params, "params-for-one");

  window.location.href = "https://www.youtube.com/watch?v=video-two";
  window.ytInitialPlayerResponse = {
    videoDetails: { videoId: "video-two" }
  };
  listeners.get("yt-navigate-finish")();

  assert.equal(postedMessages.at(-1).videoId, "video-two");
  assert.equal(postedMessages.at(-1).transcript.params, "");
});
