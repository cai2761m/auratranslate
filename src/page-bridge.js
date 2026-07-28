(function bridgeYouTubePlayerResponse() {
  "use strict";

  const CHANNEL = "__ytbt_player_response__";
  let lastSignature = "";
  const capturedCaptionUrls = new Map();

  function textFromName(name) {
    if (!name) {
      return "";
    }
    if (typeof name.simpleText === "string") {
      return name.simpleText;
    }
    if (Array.isArray(name.runs)) {
      return name.runs.map((run) => run.text || "").join("");
    }
    return "";
  }

  function readPlayerResponse() {
    const candidates = [];
    const player = document.querySelector("#movie_player");

    try {
      if (player && typeof player.getPlayerResponse === "function") {
        const response = player.getPlayerResponse();
        if (response) {
          candidates.push(response);
        }
      }
    } catch (error) {
      // The internal player API can be temporarily unavailable during navigation.
    }

    if (window.ytInitialPlayerResponse) {
      candidates.push(window.ytInitialPlayerResponse);
    }

    const raw = window.ytplayer &&
      window.ytplayer.config &&
      window.ytplayer.config.args &&
      window.ytplayer.config.args.player_response;

    if (typeof raw === "string") {
      try {
        candidates.push(JSON.parse(raw));
      } catch (error) {
        // Ignore malformed or temporarily incomplete player configuration.
      }
    } else if (raw) {
      candidates.push(raw);
    }

    const currentVideoId = readUrlVideoId();
    if (currentVideoId) {
      return candidates.find((response) => responseVideoId(response) === currentVideoId) || null;
    }

    return candidates[0] || null;
  }

  function readUrlVideoId() {
    try {
      return new URL(window.location.href).searchParams.get("v") || "";
    } catch (error) {
      return "";
    }
  }

  function responseVideoId(response) {
    return String(response && response.videoDetails && response.videoDetails.videoId || "");
  }

  function readYtcfgValue(name) {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        return window.ytcfg.get(name);
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function findTranscriptParams(value, depth) {
    if (!value || depth > 14) {
      return "";
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const params = findTranscriptParams(item, depth + 1);
        if (params) {
          return params;
        }
      }
      return "";
    }

    if (typeof value !== "object") {
      return "";
    }

    if (
      value.getTranscriptEndpoint &&
      typeof value.getTranscriptEndpoint.params === "string"
    ) {
      return value.getTranscriptEndpoint.params;
    }

    for (const item of Object.values(value)) {
      const params = findTranscriptParams(item, depth + 1);
      if (params) {
        return params;
      }
    }

    return "";
  }

  function captionTrackKey(videoId, languageCode, kind) {
    return [
      String(videoId || ""),
      String(languageCode || "").toLowerCase(),
      String(kind || "").toLowerCase()
    ].join(":");
  }

  function captionUrlQuality(url) {
    let score = 0;
    if (url.searchParams.has("pot")) {
      score += 100;
    }
    if (url.searchParams.has("potc")) {
      score += 10;
    }
    if (url.searchParams.get("fmt") === "json3") {
      score += 2;
    }
    if (url.searchParams.get("c") === "WEB") {
      score += 1;
    }
    return score;
  }

  function collectCapturedCaptionUrls(videoId) {
    if (
      !videoId ||
      typeof performance === "undefined" ||
      typeof performance.getEntriesByType !== "function"
    ) {
      return;
    }

    let entries = [];
    try {
      entries = performance.getEntriesByType("resource");
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      try {
        const url = new URL(entry && entry.name || "", window.location.href);
        const isYouTubeHost =
          url.hostname === "youtube.com" ||
          url.hostname.endsWith(".youtube.com");
        if (
          url.protocol !== "https:" ||
          !isYouTubeHost ||
          url.pathname !== "/api/timedtext" ||
          url.searchParams.get("v") !== videoId ||
          url.searchParams.has("tlang")
        ) {
          continue;
        }

        const languageCode = url.searchParams.get("lang") || "";
        if (!languageCode) {
          continue;
        }

        const key = captionTrackKey(
          videoId,
          languageCode,
          url.searchParams.get("kind") || ""
        );
        const quality = captionUrlQuality(url);
        const current = capturedCaptionUrls.get(key);
        if (!current || quality >= current.quality) {
          capturedCaptionUrls.set(key, {
            quality,
            url: url.toString()
          });
        }
      } catch (error) {
        // Ignore malformed or non-URL performance entries.
      }
    }
  }

  function capturedCaptionUrl(track, videoId) {
    const languageCode = String(track.languageCode || "");
    const kind =
      String(track.kind || "") ||
      (String(track.vssId || "").startsWith("a.") ? "asr" : "");
    const exact = capturedCaptionUrls.get(
      captionTrackKey(videoId, languageCode, kind)
    );
    const withoutKind = capturedCaptionUrls.get(
      captionTrackKey(videoId, languageCode, "")
    );
    return (exact || withoutKind || {}).url || "";
  }

  function sanitizeTrack(track, videoId) {
    return {
      baseUrl: capturedCaptionUrl(track, videoId) || track.baseUrl || "",
      languageCode: track.languageCode || "",
      kind: track.kind || "",
      vssId: track.vssId || "",
      name: textFromName(track.name),
      isTranslatable: Boolean(track.isTranslatable)
    };
  }

  function disableNativeCaptions() {
    const player = document.querySelector("#movie_player");
    const subtitleButton = document.querySelector(".ytp-subtitles-button");

    try {
      if (subtitleButton && subtitleButton.getAttribute("aria-pressed") === "true") {
        subtitleButton.click();
      }
    } catch (error) {
      // Ignore page UI races.
    }

    if (!player) {
      return;
    }

    const calls = [
      () => player.unloadModule && player.unloadModule("captions"),
      () => player.setOption && player.setOption("captions", "track", {}),
      () => player.setOption && player.setOption("captions", "track", null),
      () => player.setOption && player.setOption("captions", "track", undefined),
      () => player.updateSubtitlesUserSettings && player.updateSubtitlesUserSettings({ track: null })
    ];

    for (const call of calls) {
      try {
        call();
      } catch (error) {
        // YouTube changes these internal player APIs frequently.
      }
    }
  }

  function emitPlayerResponse(force) {
    const response = readPlayerResponse();
    const tracks =
      response &&
      response.captions &&
      response.captions.playerCaptionsTracklistRenderer &&
      response.captions.playerCaptionsTracklistRenderer.captionTracks;

    const videoId =
      response &&
      response.videoDetails &&
      response.videoDetails.videoId;

    if (!videoId) {
      return;
    }

    collectCapturedCaptionUrls(videoId);
    const sanitizedTracks = Array.isArray(tracks)
      ? tracks.map((track) => sanitizeTrack(track, videoId))
      : [];
    const transcriptParams = findTranscriptParams(window.ytInitialData, 0);
    const innertubeApiKey = readYtcfgValue("INNERTUBE_API_KEY") || "";
    const innertubeContext =
      readYtcfgValue("INNERTUBE_CONTEXT") ||
      {
        client: {
          clientName: readYtcfgValue("INNERTUBE_CLIENT_NAME") || "WEB",
          clientVersion: readYtcfgValue("INNERTUBE_CLIENT_VERSION") || "2.20240601.00.00",
          hl: readYtcfgValue("HL") || "en",
          gl: readYtcfgValue("GL") || "US",
          visitorData: readYtcfgValue("VISITOR_DATA") || ""
        }
      };

    const signature = `${videoId}:${sanitizedTracks.map((track) => track.baseUrl).join("|")}:${transcriptParams}:${innertubeApiKey}`;
    if (!force && signature === lastSignature) {
      return;
    }

    lastSignature = signature;
    window.postMessage(
      {
        channel: CHANNEL,
        type: "PLAYER_RESPONSE",
        videoId,
        title: response.videoDetails && response.videoDetails.title,
        captionTracks: sanitizedTracks,
        transcript: {
          params: transcriptParams,
          apiKey: innertubeApiKey,
          context: innertubeContext,
          clientName: readYtcfgValue("INNERTUBE_CLIENT_NAME") || "",
          clientVersion: readYtcfgValue("INNERTUBE_CLIENT_VERSION") || "",
          visitorData: readYtcfgValue("VISITOR_DATA") || ""
        }
      },
      window.location.origin
    );
  }

  window.addEventListener("yt-navigate-finish", () => setTimeout(emitPlayerResponse, 250));
  window.addEventListener("yt-page-data-updated", () => setTimeout(emitPlayerResponse, 250));
  window.addEventListener("popstate", () => setTimeout(emitPlayerResponse, 250));
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (data && data.channel === CHANNEL && data.type === "DISABLE_NATIVE_CAPTIONS") {
      disableNativeCaptions();
    } else if (data && data.channel === CHANNEL && data.type === "REQUEST_PLAYER_RESPONSE") {
      emitPlayerResponse(true);
    }
  });
  document.addEventListener("readystatechange", emitPlayerResponse);
  setInterval(emitPlayerResponse, 1500);
  emitPlayerResponse();
})();
