(function bridgeYouTubePlayerResponse() {
  "use strict";

  const CHANNEL = "__ytbt_player_response__";
  const CAPTION_CAPTURE_MAX_AGE_MS = 2 * 60 * 1000;
  const MAX_CAPTURED_TEXT_LENGTH = 2 * 1024 * 1024;
  const NATIVE_CAPTION_REQUEST_TIMEOUT_MS = 6000;
  const NATIVE_TRACK_RETRY_DELAY_MS = 400;
  const NATIVE_TRACK_MAX_RETRIES = 5;
  const FETCH_INTERCEPTOR_MARKER = "__ytbtTimedTextFetchInterceptor__";
  const XHR_INTERCEPTOR_MARKER = "__ytbtTimedTextXhrInterceptor__";
  let lastSignature = "";
  let captionCaptureRevision = 0;
  let capturedVideoId = "";
  let transcriptDataReference = null;
  let transcriptDataOwnerVideoId = "";
  let pendingNativeCaptionRequest = null;
  const capturedCaptionUrls = new Map();
  const processedPerformanceEntries = new Set();

  // The desktop player exposes #movie_player. Firefox for Android may render
  // the same player without that id, but it still keeps the html5 player class.
  function findPlayerElement() {
    return document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player");
  }

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
    const player = findPlayerElement();

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

  function readInitialDataVideoId(data) {
    try {
      return String(
        data &&
        data.currentVideoEndpoint &&
        data.currentVideoEndpoint.watchEndpoint &&
        data.currentVideoEndpoint.watchEndpoint.videoId ||
        ""
      );
    } catch (error) {
      return "";
    }
  }

  function transcriptParamsForVideo(videoId) {
    const data = window.ytInitialData;
    if (!data) {
      return "";
    }

    const declaredVideoId = readInitialDataVideoId(data);
    if (data !== transcriptDataReference) {
      transcriptDataReference = data;
      transcriptDataOwnerVideoId = declaredVideoId || videoId;
    } else if (declaredVideoId) {
      transcriptDataOwnerVideoId = declaredVideoId;
    }
    if (transcriptDataOwnerVideoId && transcriptDataOwnerVideoId !== videoId) {
      return "";
    }
    return findTranscriptParams(data, 0);
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

  function captionKind(track) {
    return String(track && track.kind || "") ||
      (String(track && (track.vssId || track.vss_id || track.id) || "").startsWith("a.") ? "asr" : "");
  }

  function captionUrlExpiresAt(url) {
    const raw = Number(url.searchParams.get("expire"));
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    return raw > 1000000000000 ? raw : raw * 1000;
  }

  function isFreshTimestamp(timestamp, now) {
    return Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp <= now + 30000 &&
      now - timestamp <= CAPTION_CAPTURE_MAX_AGE_MS;
  }

  function isFreshCapturedUrl(capture, now) {
    return Boolean(
      capture &&
      capture.url &&
      isFreshTimestamp(capture.urlCapturedAt, now) &&
      (!capture.urlExpiresAt || now + 5000 < capture.urlExpiresAt)
    );
  }

  function isFreshCapturedText(capture, now) {
    return Boolean(capture && capture.text);
  }

  function parseTimedTextUrl(rawUrl, expectedVideoId) {
    try {
      const url = new URL(String(rawUrl || ""), window.location.href);
      const isYouTubeHost =
        url.hostname === "youtube.com" ||
        url.hostname.endsWith(".youtube.com");
      const videoId = url.searchParams.get("v") || "";
      const languageCode = url.searchParams.get("lang") || "";
      const currentUrlVideoId = readUrlVideoId();

      if (
        url.protocol !== "https:" ||
        !isYouTubeHost ||
        url.pathname !== "/api/timedtext" ||
        url.searchParams.has("tlang") ||
        !videoId ||
        !languageCode ||
        (expectedVideoId && videoId !== expectedVideoId) ||
        (currentUrlVideoId && videoId !== currentUrlVideoId)
      ) {
        return null;
      }

      return {
        url,
        videoId,
        languageCode,
        kind: url.searchParams.get("kind") || ""
      };
    } catch (error) {
      return null;
    }
  }

  function pruneCapturedCaptionUrls(videoId, now) {
    let changed = false;

    for (const [key, capture] of capturedCaptionUrls) {
      if (capture.videoId !== videoId) {
        capturedCaptionUrls.delete(key);
        changed = true;
        continue;
      }

      if (capture.url && !isFreshCapturedUrl(capture, now)) {
        capture.url = "";
        capture.quality = 0;
        capture.urlCapturedAt = 0;
        capture.urlExpiresAt = 0;
        changed = true;
      }
      if (!capture.url && !capture.text) {
        capturedCaptionUrls.delete(key);
      }
    }

    if (changed) {
      captionCaptureRevision += 1;
    }
    return changed;
  }

  function prepareCaptionCacheForVideo(videoId, now) {
    if (!videoId) {
      return;
    }

    if (capturedVideoId && capturedVideoId !== videoId) {
      if (
        pendingNativeCaptionRequest &&
        pendingNativeCaptionRequest.videoId !== videoId
      ) {
        finishPendingNativeCaptionRequest(pendingNativeCaptionRequest, false);
      }
      if (capturedCaptionUrls.size) {
        capturedCaptionUrls.clear();
        captionCaptureRevision += 1;
      }
    }
    capturedVideoId = videoId;
    pruneCapturedCaptionUrls(videoId, now);
  }

  function shouldReplaceCapturedUrl(current, candidate) {
    if (!current.url) {
      return true;
    }

    const currentHasProofToken = current.quality >= 100;
    const candidateHasProofToken = candidate.quality >= 100;
    if (currentHasProofToken !== candidateHasProofToken) {
      return candidateHasProofToken;
    }
    if (candidate.capturedAt !== current.urlCapturedAt) {
      return candidate.capturedAt > current.urlCapturedAt;
    }
    return candidate.quality >= current.quality;
  }

  function storeCapturedCaption(rawUrl, text, capturedAt, expectedVideoId) {
    const parsed = parseTimedTextUrl(rawUrl, expectedVideoId);
    if (!parsed) {
      return null;
    }

    const now = Date.now();
    const effectiveCapturedAt = isFreshTimestamp(capturedAt, now) ? capturedAt : now;
    prepareCaptionCacheForVideo(parsed.videoId, now);

    const key = captionTrackKey(parsed.videoId, parsed.languageCode, parsed.kind);
    const current = capturedCaptionUrls.get(key) || {
      videoId: parsed.videoId,
      languageCode: parsed.languageCode,
      kind: parsed.kind,
      url: "",
      quality: 0,
      urlCapturedAt: 0,
      urlExpiresAt: 0,
      text: "",
      textCapturedAt: 0,
      lastObservedUrl: ""
    };
    const canonicalUrl = parsed.url.toString();
    const expiresAt = captionUrlExpiresAt(parsed.url);
    const candidate = {
      capturedAt: effectiveCapturedAt,
      quality: captionUrlQuality(parsed.url)
    };
    const validUrl = !expiresAt || now + 5000 < expiresAt;
    const safeText = typeof text === "string" &&
      text.length <= MAX_CAPTURED_TEXT_LENGTH &&
      text.trim()
      ? text
      : "";
    let changed = false;

    if (validUrl && shouldReplaceCapturedUrl(current, candidate)) {
      changed = changed || current.url !== canonicalUrl;
      current.url = canonicalUrl;
      current.quality = candidate.quality;
      current.urlCapturedAt = effectiveCapturedAt;
      current.urlExpiresAt = expiresAt;
    } else if (validUrl && current.url === canonicalUrl) {
      current.urlCapturedAt = Math.max(current.urlCapturedAt, effectiveCapturedAt);
      current.urlExpiresAt = expiresAt;
    }

    if (safeText) {
      changed = changed || current.text !== safeText;
      current.text = safeText;
      current.textCapturedAt = effectiveCapturedAt;
    }

    if (current.lastObservedUrl !== canonicalUrl) {
      current.lastObservedUrl = canonicalUrl;
      changed = true;
    }

    if (!current.url && !current.text) {
      return {
        changed: false,
        hasBody: false,
        parsed
      };
    }

    capturedCaptionUrls.set(key, current);
    if (changed) {
      captionCaptureRevision += 1;
    }
    return {
      changed,
      hasBody: Boolean(safeText),
      parsed
    };
  }

  function performanceEntryTimestamp(entry, now) {
    try {
      const timeOrigin = Number(performance.timeOrigin);
      const relativeTime = Number(entry.responseEnd || entry.startTime);
      if (Number.isFinite(timeOrigin) && Number.isFinite(relativeTime) && relativeTime > 0) {
        return timeOrigin + relativeTime;
      }
    } catch (error) {
      // Fall back to observation time for older Resource Timing implementations.
    }
    return now;
  }

  function performanceEntryKey(entry) {
    return [
      String(entry && entry.name || ""),
      String(entry && entry.startTime || ""),
      String(entry && entry.responseEnd || ""),
      String(entry && entry.duration || "")
    ].join("|");
  }

  function collectCapturedCaptionUrls(videoId) {
    const now = Date.now();
    prepareCaptionCacheForVideo(videoId, now);
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
      const entryKey = performanceEntryKey(entry);
      if (processedPerformanceEntries.has(entryKey)) {
        continue;
      }
      processedPerformanceEntries.add(entryKey);

      try {
        const capturedAt = performanceEntryTimestamp(entry, now);
        if (!isFreshTimestamp(capturedAt, now)) {
          continue;
        }
        if (Number(entry && entry.responseStatus) >= 400) {
          continue;
        }
        storeCapturedCaption(entry && entry.name, "", capturedAt, videoId);
      } catch (error) {
        // Ignore malformed or inaccessible Resource Timing entries.
      }
    }
  }

  function capturedCaptionData(track, videoId) {
    const now = Date.now();
    prepareCaptionCacheForVideo(videoId, now);
    const languageCode = String(track && track.languageCode || "");
    const kind = captionKind(track);
    const exact = capturedCaptionUrls.get(
      captionTrackKey(videoId, languageCode, kind)
    );
    const withoutKind = capturedCaptionUrls.get(
      captionTrackKey(videoId, languageCode, "")
    );
    const fallback = withoutKind !== exact ? withoutKind : null;

    return {
      url: isFreshCapturedUrl(exact, now)
        ? exact.url
        : (isFreshCapturedUrl(fallback, now) ? fallback.url : ""),
      text: isFreshCapturedText(exact, now)
        ? exact.text
        : (isFreshCapturedText(fallback, now) ? fallback.text : "")
    };
  }

  function sanitizeTrack(track, videoId) {
    const captured = capturedCaptionData(track, videoId);
    const sanitized = {
      baseUrl: captured.url || track.baseUrl || "",
      languageCode: track.languageCode || "",
      kind: track.kind || "",
      vssId: track.vssId || "",
      name: textFromName(track.name),
      isTranslatable: Boolean(track.isTranslatable)
    };
    if (captured.text) {
      sanitized.capturedText = captured.text;
    }
    return sanitized;
  }

  function captionCaptureMatchesTrack(parsed, videoId, track) {
    if (!parsed || parsed.videoId !== videoId) {
      return false;
    }
    const requestedLanguage = String(track && track.languageCode || "").toLowerCase();
    const requestedKind = captionKind(track).toLowerCase();
    const capturedKind = String(parsed.kind || "").toLowerCase();
    return Boolean(
      requestedLanguage &&
      parsed.languageCode.toLowerCase() === requestedLanguage &&
      (!requestedKind || !capturedKind || requestedKind === capturedKind)
    );
  }

  function acceptCapturedCaptionResponse(rawUrl, text) {
    const expectedVideoId = readUrlVideoId() || responseVideoId(readPlayerResponse());
    const result = storeCapturedCaption(rawUrl, text, Date.now(), expectedVideoId);
    if (!result) {
      return;
    }

    const pending = pendingNativeCaptionRequest;
    const completesPending = Boolean(
      pending &&
      result.hasBody &&
      captionCaptureMatchesTrack(result.parsed, pending.videoId, pending.track)
    );
    if (result.changed || completesPending) {
      emitPlayerResponse(true);
    }
    if (completesPending) {
      finishPendingNativeCaptionRequest(pending, true);
    }
  }

  function fetchInputUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    return input && typeof input.url === "string" ? input.url : "";
  }

  function inspectFetchResponse(response, requestedUrl) {
    try {
      if (!response || response.ok === false) {
        return;
      }
      const responseUrl = typeof response.url === "string" && response.url
        ? response.url
        : requestedUrl;
      const expectedVideoId = readUrlVideoId() || responseVideoId(readPlayerResponse());
      if (!parseTimedTextUrl(responseUrl, expectedVideoId)) {
        return;
      }

      const contentLength = Number(
        response.headers && typeof response.headers.get === "function"
          ? response.headers.get("content-length")
          : 0
      );
      if (contentLength > MAX_CAPTURED_TEXT_LENGTH) {
        acceptCapturedCaptionResponse(responseUrl, "");
        return;
      }

      let clone;
      try {
        clone = response.clone();
      } catch (error) {
        acceptCapturedCaptionResponse(responseUrl, "");
        return;
      }
      clone.text().then(
        (text) => acceptCapturedCaptionResponse(responseUrl, text),
        () => acceptCapturedCaptionResponse(responseUrl, "")
      );
    } catch (error) {
      // Inspection must never change the page's fetch behavior.
    }
  }

  function installFetchInterceptor() {
    const originalFetch = window.fetch;
    if (
      typeof originalFetch !== "function" ||
      originalFetch[FETCH_INTERCEPTOR_MARKER]
    ) {
      return;
    }

    function interceptedFetch() {
      const requestedUrl = fetchInputUrl(arguments[0]);
      const result = originalFetch.apply(this, arguments);
      try {
        if (result && typeof result.then === "function") {
          result.then(
            (response) => inspectFetchResponse(response, requestedUrl),
            () => {}
          );
        }
      } catch (error) {
        // Observing a non-standard thenable must not alter the caller's result.
      }
      return result;
    }

    try {
      Object.defineProperty(interceptedFetch, FETCH_INTERCEPTOR_MARKER, {
        value: true
      });
      window.fetch = interceptedFetch;
    } catch (error) {
      // Some pages freeze globals; Resource Timing remains available as fallback.
    }
  }

  function inspectXhrResponse(xhr, requestedUrl) {
    try {
      const status = Number(xhr.status);
      if (status < 200 || status >= 300) {
        return;
      }
      const responseUrl = xhr.responseURL || requestedUrl;
      const expectedVideoId = readUrlVideoId() || responseVideoId(readPlayerResponse());
      if (!parseTimedTextUrl(responseUrl, expectedVideoId)) {
        return;
      }

      const responseType = String(xhr.responseType || "");
      let text = "";
      if (!responseType || responseType === "text") {
        text = String(xhr.responseText || "");
      } else if (responseType === "json" && xhr.response != null) {
        text = JSON.stringify(xhr.response);
      }
      acceptCapturedCaptionResponse(responseUrl, text);
    } catch (error) {
      // Reading responseText can throw for binary response types.
    }
  }

  function installXhrInterceptor() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr || !Xhr.prototype || typeof Xhr.prototype.open !== "function") {
      return;
    }

    const originalOpen = Xhr.prototype.open;
    if (originalOpen[XHR_INTERCEPTOR_MARKER]) {
      return;
    }
    const requestUrls = new WeakMap();
    const observedRequests = new WeakSet();

    function interceptedOpen(method, url) {
      const result = originalOpen.apply(this, arguments);
      try {
        requestUrls.set(this, String(url || ""));
        if (!observedRequests.has(this) && typeof this.addEventListener === "function") {
          observedRequests.add(this);
          this.addEventListener("loadend", () => {
            inspectXhrResponse(this, requestUrls.get(this) || "");
          });
        }
      } catch (error) {
        // Opening the page's request must still succeed if observation fails.
      }
      return result;
    }

    try {
      Object.defineProperty(interceptedOpen, XHR_INTERCEPTOR_MARKER, {
        value: true
      });
      Xhr.prototype.open = interceptedOpen;
    } catch (error) {
      // Ignore pages with a frozen XMLHttpRequest prototype.
    }
  }

  function readPlayerOption(player, option) {
    try {
      if (player && typeof player.getOption === "function") {
        return player.getOption("captions", option);
      }
    } catch (error) {
      // Internal player options can disappear while the player is rebuilding.
    }
    return null;
  }

  function readNativeCaptionsEnabled(player, subtitleButton) {
    try {
      if (player && typeof player.isSubtitlesOn === "function") {
        const enabled = player.isSubtitlesOn();
        if (typeof enabled === "boolean") {
          return enabled;
        }
      }
    } catch (error) {
      // Fall through to the UI state.
    }

    try {
      if (subtitleButton && typeof subtitleButton.getAttribute === "function") {
        const pressed = subtitleButton.getAttribute("aria-pressed");
        if (pressed === "true" || pressed === "false") {
          return pressed === "true";
        }
      }
    } catch (error) {
      // The button can be replaced during SPA navigation.
    }
    return null;
  }

  function setNativeCaptionsEnabled(player, subtitleButton, enabled) {
    if (typeof enabled !== "boolean") {
      return;
    }
    let current = readNativeCaptionsEnabled(player, subtitleButton);
    if (current === enabled) {
      return;
    }

    try {
      if (player && typeof player.toggleSubtitlesOn === "function") {
        player.toggleSubtitlesOn();
      }
    } catch (error) {
      // Fall back to the visible control below.
    }

    current = readNativeCaptionsEnabled(player, subtitleButton);
    if (current === enabled) {
      return;
    }
    try {
      if (subtitleButton && typeof subtitleButton.click === "function") {
        subtitleButton.click();
      }
    } catch (error) {
      // Ignore a control that was detached during navigation.
    }
  }

  function normalizeRequestedTrack(track) {
    const normalized = {
      baseUrl: String(track && track.baseUrl || ""),
      languageCode: String(track && track.languageCode || ""),
      kind: String(track && track.kind || ""),
      vssId: String(track && (track.vssId || track.id) || "")
    };

    if (normalized.baseUrl) {
      try {
        const url = new URL(normalized.baseUrl, window.location.href);
        normalized.languageCode = normalized.languageCode || url.searchParams.get("lang") || "";
        normalized.kind = normalized.kind || url.searchParams.get("kind") || "";
      } catch (error) {
        // The player can still match the explicit language fields.
      }
    }
    return normalized;
  }

  function findPlayerCaptionTrack(tracklist, requestedTrack) {
    const tracks = Array.isArray(tracklist)
      ? tracklist
      : (tracklist && Array.isArray(tracklist.captionTracks) ? tracklist.captionTracks : []);
    const requestedLanguage = requestedTrack.languageCode.toLowerCase();
    const requestedVssId = requestedTrack.vssId.toLowerCase();
    const requestedKind = captionKind(requestedTrack).toLowerCase();
    let languageMatch = null;

    for (const track of tracks) {
      const languageCode = String(track && track.languageCode || "").toLowerCase();
      const vssId = String(track && (track.vssId || track.id) || "").toLowerCase();
      const kind = captionKind(track).toLowerCase();
      if (requestedVssId && vssId && requestedVssId === vssId) {
        return track;
      }
      if (languageCode !== requestedLanguage) {
        continue;
      }
      if (!requestedKind || !kind || requestedKind === kind) {
        return track;
      }
      languageMatch = languageMatch || track;
    }
    return languageMatch;
  }

  function finishPendingNativeCaptionRequest(request, restoreState) {
    if (!request || pendingNativeCaptionRequest !== request) {
      return;
    }
    pendingNativeCaptionRequest = null;
    if (request.timeoutId && typeof clearTimeout === "function") {
      clearTimeout(request.timeoutId);
    }

    if (!restoreState || readUrlVideoId() !== request.videoId) {
      return;
    }
    if (
      request.originalEnabled === true &&
      request.originalTrack &&
      request.originalTrack !== request.selectedTrack
    ) {
      try {
        if (request.player && typeof request.player.setOption === "function") {
          request.player.setOption("captions", "track", request.originalTrack);
        }
      } catch (error) {
        // Restoring the on/off state remains the essential cleanup.
      }
    }
    setNativeCaptionsEnabled(
      request.player,
      request.subtitleButton,
      request.originalEnabled
    );
  }

  function requestNativeCaptions(data) {
    const videoId = String(data && data.videoId || "");
    const currentVideoId = readUrlVideoId() || responseVideoId(readPlayerResponse());
    const track = normalizeRequestedTrack(data && data.track);
    if (!videoId || videoId !== currentVideoId || !track.languageCode) {
      return;
    }

    collectCapturedCaptionUrls(videoId);
    if (capturedCaptionData(track, videoId).text) {
      emitPlayerResponse(true);
      return;
    }

    const player = findPlayerElement();
    if (!player) {
      return;
    }
    if (pendingNativeCaptionRequest) {
      const pending = pendingNativeCaptionRequest;
      const sameRequest =
        pending.videoId === videoId &&
        captionTrackKey(videoId, pending.track.languageCode, captionKind(pending.track)) ===
          captionTrackKey(videoId, track.languageCode, captionKind(track));
      if (sameRequest) {
        return;
      }
      finishPendingNativeCaptionRequest(pending, true);
    }

    const subtitleButton = document.querySelector(".ytp-subtitles-button");
    const originalEnabled = readNativeCaptionsEnabled(player, subtitleButton);
    const originalTrack = readPlayerOption(player, "track");
    const request = {
      videoId,
      track,
      player,
      subtitleButton,
      originalEnabled,
      originalTrack,
      selectedTrack: null,
      timeoutId: 0
    };
    pendingNativeCaptionRequest = request;
    request.timeoutId = setTimeout(() => {
      finishPendingNativeCaptionRequest(request, true);
    }, NATIVE_CAPTION_REQUEST_TIMEOUT_MS);

    setNativeCaptionsEnabled(player, subtitleButton, true);
    const tracklist = readPlayerOption(player, "tracklist");
    request.selectedTrack = findPlayerCaptionTrack(tracklist, track) || {
      languageCode: track.languageCode,
      kind: track.kind,
      vssId: track.vssId
    };
    try {
      if (typeof player.setOption === "function") {
        player.setOption("captions", "track", request.selectedTrack);
      }
    } catch (error) {
      // The timeout restores the original state if no request is captured.
    }
  }

  function disableNativeCaptions() {
    if (pendingNativeCaptionRequest) {
      finishPendingNativeCaptionRequest(pendingNativeCaptionRequest, false);
    }
    const player = findPlayerElement();
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
    const transcriptParams = transcriptParamsForVideo(videoId);
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

    const signature = `${videoId}:${sanitizedTracks.map((track) => track.baseUrl).join("|")}:${transcriptParams}:${innertubeApiKey}:${captionCaptureRevision}`;
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

  installFetchInterceptor();
  installXhrInterceptor();
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
    } else if (data && data.channel === CHANNEL && data.type === "REQUEST_NATIVE_CAPTIONS") {
      requestNativeCaptions(data);
    }
  });
  document.addEventListener("readystatechange", emitPlayerResponse);
  setInterval(emitPlayerResponse, 1500);
  emitPlayerResponse();
})();
