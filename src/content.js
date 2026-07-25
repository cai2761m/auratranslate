(function runContentScript() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const CHANNEL = "__ytbt_player_response__";
  const DRIVE_CHANNEL = "__ytbt_drive_transcript__";
  const IS_DRIVE_PLAYER =
    window.location.hostname === "youtube.googleapis.com" &&
    window.location.pathname.startsWith("/embed");
  const BATCH_SIZE = 30;
  const GEMINI_BATCH_SIZE = 8;
  const CUSTOM_BATCH_SIZE = 15;
  const RETRY_BATCH_SIZE = 5;
  const GEMINI_RETRY_BATCH_SIZE = 3;
  const CUSTOM_RETRY_BATCH_SIZE = 5;
  const MAX_CUE_TRANSLATION_RETRIES = 2;
  const MAX_PARALLEL_BATCHES = 2;
  const GEMINI_MAX_PARALLEL_BATCHES = 1;
  const CUSTOM_MAX_PARALLEL_BATCHES = 4;
  const TRANSLATION_MESSAGE_TIMEOUT_MS = 130000;
  const SEGMENTATION_MESSAGE_TIMEOUT_MS = 600000;
  const PRIORITY_WINDOW_MS = 120000;
  const URGENT_RESCHEDULE_MS = 1000;
  const RATE_LIMIT_BACKOFF_MS = 60000;
  const SERVICE_BACKOFF_MS = 30000;
  const DEFAULT_API_BACKOFF_MS = 10000;
  const DRAG_LONG_PRESS_MS = 220;
  const DRAG_EDGE_PADDING_PX = 12;
  const NATIVE_CAPTION_SELECTOR = [
    ".ytp-caption-window-container",
    ".ytp-caption-window-rollup",
    ".ytp-caption-window-bottom",
    ".ytp-caption-window-top",
    ".caption-window",
    ".captions-text",
    ".caption-visual-line",
    ".ytp-caption-segment",
    ".html5-video-player [class*='caption' i]",
    ".html5-video-player [id*='caption' i]",
    ".html5-video-player [class*='subtitle' i]",
    ".html5-video-player [id*='subtitle' i]"
  ].join(",");

  const state = {
    settings: Object.assign({}, Core.DEFAULT_SETTINGS),
    lastPlayerResponse: null,
    driveTranscriptPayload: null,
    videoId: "",
    track: null,
    transcript: null,
    trackFingerprint: "",
    cues: [],
    queue: [],
    inFlight: new Map(),
    batchSerial: 0,
    loadingToken: 0,
    statusText: "",
    overlay: null,
    overlayParts: null,
    overlayDrag: {
      pointerId: null,
      timer: null,
      active: false,
      startClientX: 0,
      startClientY: 0,
      offsetX: 0,
      offsetY: 0,
      lastClientX: 0,
      lastClientY: 0
    },
    video: null,
    nativeCaptionObserver: null,
    lastNativeCaptionSweepAt: 0,
    lastNativeCaptionDisableRequestAt: 0,
    lastUrgentScheduleAt: 0,
    apiBackoffUntil: 0,
    apiBackoffMessage: "",
    apiBackoffTimer: null,
    bridgeInjected: false,
    pumping: false
  };

  init();

  async function init() {
    await loadSettings();
    applySettings();
    if (IS_DRIVE_PLAYER) {
      bindDrivePlayerMessages();
      requestDriveTranscript();
      setInterval(requestDriveTranscript, 2000);
    } else {
      bindPageMessages();
      injectPageBridge();
    }
    bindStorageChanges();
    startNativeCaptionBlocker();
    setInterval(watchVideoElement, 1000);
    setInterval(() => updateNativeCaptionBlocking(true), 500);
    setInterval(() => requestDisableNativeCaptions(false), 1000);
    setInterval(() => {
      if (state.cues.length) {
        scheduleTranslations(getCurrentTimeMs(), false);
      }
    }, 5000);
    requestAnimationFrame(renderLoop);
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  async function loadSettings() {
    const stored = await storageGet(Core.DEFAULT_SETTINGS);
    state.settings = normalizeSettings(stored);
  }

  function normalizeSettings(settings) {
    const merged = Object.assign({}, Core.DEFAULT_SETTINGS, settings || {});
    const fontScale = Number(merged.fontScale);
    merged.fontScale = Number.isFinite(fontScale) ? Math.min(1.8, Math.max(0.7, fontScale)) : 1;
    merged.subtitleEnabled = merged.subtitleEnabled !== false;
    merged.llmSentenceSegmentationEnabled = merged.llmSentenceSegmentationEnabled !== false;
    merged.showOriginalTechnicalTerms = merged.showOriginalTechnicalTerms !== false;
    merged.targetLanguage = merged.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    merged.sourceLanguage = merged.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    merged.subtitlePosition = normalizeSubtitlePosition(merged.subtitlePosition);
    return merged;
  }

  function normalizeSubtitlePosition(position) {
    if (!position || typeof position !== "object") {
      return null;
    }

    const xPct = Number(position.xPct);
    const yPct = Number(position.yPct);
    if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) {
      return null;
    }

    return {
      xPct: Math.min(98, Math.max(2, xPct)),
      yPct: Math.min(96, Math.max(4, yPct))
    };
  }

  function bindStorageChanges() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      let changed = false;
      for (const key of Object.keys(Core.DEFAULT_SETTINGS)) {
        if (changes[key]) {
          state.settings[key] = changes[key].newValue;
          changed = true;
        }
      }

      if (!changed) {
        return;
      }

      state.settings = normalizeSettings(state.settings);
      applySettings();

      const realtimeApiChanged = Boolean(
        changes.deepseekApiKey ||
        changes.translationProvider ||
        changes.translationApiKey ||
        changes.translationBaseUrl ||
        changes.translationModel ||
        changes.translationJsonResponse
      );
      const needsSentenceSegmentationReload = Boolean(
        changes.llmSentenceSegmentationEnabled ||
        changes.sourceLanguage ||
        (state.settings.llmSentenceSegmentationEnabled &&
          (realtimeApiChanged || changes.cacheVersion))
      );

      if (needsSentenceSegmentationReload && state.driveTranscriptPayload) {
        const driveTranscriptPayload = state.driveTranscriptPayload;
        resetVideoState("", null, "");
        if (state.settings.subtitleEnabled) {
          handleDriveTranscript(driveTranscriptPayload);
        }
        return;
      }

      if (needsSentenceSegmentationReload && state.lastPlayerResponse) {
        const playerResponse = state.lastPlayerResponse;
        resetVideoState("", null, "");
        if (state.settings.subtitleEnabled) {
          handlePlayerResponse(playerResponse);
        }
        return;
      }

      if (
        realtimeApiChanged ||
        changes.targetLanguage ||
        changes.sourceLanguage ||
        changes.asrCorrectionEnabled ||
        changes.showOriginalTechnicalTerms ||
        changes.llmSentenceSegmentationEnabled ||
        changes.cacheVersion
      ) {
        for (const cue of state.cues) {
          cue.status = "pending";
          cue.translatedText = "";
        }
        state.queue = [];
        state.inFlight.clear();
        scheduleTranslations(getCurrentTimeMs(), true);
      }

      if (changes.subtitleEnabled && state.settings.subtitleEnabled && state.lastPlayerResponse) {
        handlePlayerResponse(state.lastPlayerResponse);
      } else if (
        changes.subtitleEnabled &&
        state.settings.subtitleEnabled &&
        state.driveTranscriptPayload
      ) {
        handleDriveTranscript(state.driveTranscriptPayload);
      }
    });
  }

  function applySettings() {
    document.documentElement.classList.toggle(
      "ytbt-hide-native-captions",
      Boolean(state.settings.subtitleEnabled)
    );
    updateNativeCaptionBlocking(true);

    if (state.overlay) {
      state.overlay.style.setProperty("--ytbt-font-scale", String(state.settings.fontScale));
      state.overlay.hidden = !state.settings.subtitleEnabled;
      applyOverlayPosition();
    }
  }

  function injectPageBridge() {
    if (state.bridgeInjected) {
      return;
    }

    const root = document.documentElement || document.head || document.body;
    if (!root) {
      setTimeout(injectPageBridge, 50);
      return;
    }

    state.bridgeInjected = true;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-bridge.js");
    script.async = false;
    script.onload = () => {
      script.remove();
      requestPlayerResponse();
    };
    root.appendChild(script);
  }

  function requestPlayerResponse() {
    window.postMessage(
      {
        channel: CHANNEL,
        type: "REQUEST_PLAYER_RESPONSE"
      },
      window.location.origin
    );
  }

  function bindPageMessages() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const data = event.data;
      if (!data || data.channel !== CHANNEL || data.type !== "PLAYER_RESPONSE") {
        return;
      }

      handlePlayerResponse(data);
    });
  }

  function bindDrivePlayerMessages() {
    window.addEventListener("message", (event) => {
      if (
        event.source !== window.parent ||
        event.origin !== "https://drive.google.com"
      ) {
        return;
      }

      const data = event.data;
      if (!data || data.channel !== DRIVE_CHANNEL) {
        return;
      }

      if (data.type === "DRIVE_TRANSCRIPT") {
        handleDriveTranscript(data).catch((error) => {
          setStatus(`Google Drive 字幕读取失败：${simplifyTranslationError(error && error.message ? error.message : error)}`);
        });
      } else if (data.type === "DRIVE_TRANSCRIPT_STATUS") {
        const statusFileId = String(data.fileId || "");
        if (statusFileId && statusFileId !== state.videoId) {
          state.driveTranscriptPayload = null;
          resetVideoState(statusFileId, null, "", null);
        }
        setStatus(String(data.message || ""));
      }
    });
  }

  function requestDriveTranscript() {
    if (!IS_DRIVE_PLAYER || window.parent === window) {
      return;
    }

    window.parent.postMessage(
      {
        channel: DRIVE_CHANNEL,
        type: "REQUEST_DRIVE_TRANSCRIPT"
      },
      "https://drive.google.com"
    );
  }

  async function handleDriveTranscript(payload) {
    if (!state.settings.subtitleEnabled) {
      setStatus("");
      return;
    }

    const videoId = String(payload.fileId || "");
    if (
      state.driveTranscriptPayload &&
      videoId &&
      videoId === state.videoId &&
      String(payload.signature || "") === String(state.driveTranscriptPayload.signature || "") &&
      state.cues.length
    ) {
      return;
    }

    const rawCues = Array.isArray(payload.cues)
      ? payload.cues
        .slice(0, 10000)
        .map((cue) => ({
          startMs: Number(cue && cue.startMs),
          endMs: Number(cue && cue.endMs),
          sourceText: Core.normalizeSubtitleText(cue && cue.sourceText).slice(0, 2000)
        }))
        .filter((cue) => (
          Number.isFinite(cue.startMs) &&
          Number.isFinite(cue.endMs) &&
          cue.endMs > cue.startMs &&
          cue.sourceText
        ))
      : [];

    if (!videoId || !rawCues.length) {
      setStatus("Google Drive 没有可用的转写字幕。");
      return;
    }

    const sourceLang = String(state.settings.sourceLanguage || "en").toLowerCase();
    const trackFingerprint = Core.fingerprintText([
      "google-drive",
      videoId,
      sourceLang,
      String(payload.signature || ""),
      rawCues.length
    ].join("|"));

    state.driveTranscriptPayload = payload;
    state.lastPlayerResponse = null;

    if (
      videoId === state.videoId &&
      trackFingerprint === state.trackFingerprint &&
      state.cues.length
    ) {
      return;
    }

    resetVideoState(videoId, null, trackFingerprint, null);
    setStatus("正在读取 Google Drive 转写字幕...");
    const token = state.loadingToken;

    try {
      await prepareCaptionCues(
        rawCues,
        videoId,
        trackFingerprint,
        token,
        "Google Drive 转写"
      );
    } catch (error) {
      if (token !== state.loadingToken) {
        return;
      }
      setStatus(`Google Drive 字幕读取失败：${simplifyTranslationError(error && error.message ? error.message : error)}`);
    }
  }

  async function handlePlayerResponse(payload) {
    if (!state.settings.subtitleEnabled) {
      setStatus("");
      return;
    }

    const videoId = String(payload.videoId || "");
    const urlVideoId = getUrlVideoId();
    if (urlVideoId && videoId && videoId !== urlVideoId) {
      requestPlayerResponse();
      return;
    }

    state.lastPlayerResponse = payload;
    const tracks = Array.isArray(payload.captionTracks) ? payload.captionTracks : [];
    const transcript = payload.transcript || null;
    const track = selectSourceTrack(tracks);

    if (!track && !hasTranscriptApi(transcript)) {
      resetVideoState(videoId, null, "");
      setStatus(`未找到源语言字幕轨道：这个视频可能没有 ${state.settings.sourceLanguage || "en"} 自动字幕。`);
      return;
    }

    const trackFingerprint = makeStableTrackFingerprint(videoId, track, transcript);

    if (videoId === state.videoId && trackFingerprint === state.trackFingerprint && state.cues.length) {
      return;
    }

    resetVideoState(videoId, track, trackFingerprint, transcript);
    await loadCaptionTrack(videoId, track, trackFingerprint, transcript);
  }

  function resetVideoState(videoId, track, trackFingerprint, transcript) {
    state.videoId = videoId || "";
    state.track = track;
    state.transcript = transcript || null;
    state.trackFingerprint = trackFingerprint || "";
    state.cues = [];
    state.queue = [];
    state.inFlight.clear();
    state.statusText = "";
    state.loadingToken += 1;
  }

  function makeStableTrackFingerprint(videoId, track, transcript) {
    const sourceLang = String(state.settings.sourceLanguage || "en").toLowerCase();
    if (track) {
      return Core.fingerprintText([
        "track",
        videoId || "",
        sourceLang,
        String(track.languageCode || "").toLowerCase(),
        String(track.kind || "").toLowerCase(),
        String(track.vssId || "").toLowerCase(),
        String(track.name || "").toLowerCase()
      ].join("|"));
    }

    return Core.fingerprintText([
      "transcript",
      videoId || "",
      sourceLang,
      transcript && transcript.apiKey ? "api" : ""
    ].join("|"));
  }

  function selectSourceTrack(tracks) {
    const candidates = tracks
      .filter((track) => track && track.baseUrl && isSourceTrack(track))
      .sort((left, right) => scoreTrack(left) - scoreTrack(right));

    return candidates[0] || null;
  }

  function isSourceTrack(track) {
    const sourceLang = String(state.settings.sourceLanguage || "en").toLowerCase();
    const languageCode = String(track.languageCode || "").toLowerCase();
    const vssId = String(track.vssId || "").toLowerCase();
    const name = String(track.name || "").toLowerCase();
    
    return languageCode === sourceLang || languageCode.startsWith(sourceLang + "-") || vssId.includes(`.${sourceLang}`) || name.includes(sourceLang);
  }

  function scoreTrack(track) {
    const sourceLang = String(state.settings.sourceLanguage || "en").toLowerCase();
    const languageCode = String(track.languageCode || "").toLowerCase();
    const isAsr = String(track.kind || "").toLowerCase() === "asr";
    
    let languageScore = 10;
    if (languageCode === sourceLang) {
      languageScore = 0;
    } else if (languageCode.startsWith(sourceLang + "-")) {
      languageScore = 2;
    }
    
    // Manual tracks should have LOWER score (higher priority than ASR)
    return (isAsr ? 20 : 0) + languageScore;
  }

  async function loadCaptionTrack(videoId, track, trackFingerprint, transcript) {
    const token = state.loadingToken;
    setStatus("正在读取 YouTube 字幕轨道...");

    try {
      const rawCues = await fetchCaptionData(track, videoId, transcript);
      await prepareCaptionCues(
        rawCues,
        videoId,
        trackFingerprint,
        token,
        "YouTube 字幕轨道"
      );
    } catch (error) {
      if (token !== state.loadingToken) {
        return;
      }
      setStatus(`字幕读取失败：${formatCaptionLoadError(error)}`);
    }
  }

  async function prepareCaptionCues(rawCues, videoId, trackFingerprint, token, sourceLabel) {
    if (
      token !== state.loadingToken ||
      videoId !== state.videoId ||
      trackFingerprint !== state.trackFingerprint
    ) {
      return;
    }

    const merged = Core.mergeCaptionFragments(rawCues);
    if (!merged.length) {
      setStatus(`${sourceLabel || "字幕轨道"}没有可用的字幕内容。`);
      return;
    }

    let preparedCues = merged;
    let segmentationFallbackMessage = "";
    if (state.settings.llmSentenceSegmentationEnabled && hasApiKey()) {
      const segmentationInput = Core.splitCaptionCuesAtSentenceBoundaries(merged);
      setStatus(`正在使用 LLM 智能断句 0/${segmentationInput.length}...`);
      try {
        const response = await sendMessage(
          {
            type: "SEGMENT_SUBTITLES",
            videoId,
            trackFingerprint,
            cues: segmentationInput.map((cue) => ({
              id: cue.id,
              startMs: cue.startMs,
              endMs: cue.endMs,
              sourceText: cue.sourceText
            }))
          },
          SEGMENTATION_MESSAGE_TIMEOUT_MS
        );
        if (!response || response.ok === false) {
          const error = response && response.errors && response.errors[0];
          throw new Error(error && error.message ? error.message : "LLM 智能断句失败");
        }
        preparedCues = Core.applySentenceSegmentationGroups(
          segmentationInput,
          response.groups || []
        );
      } catch (error) {
        segmentationFallbackMessage = simplifyTranslationError(error && error.message ? error.message : error);
        preparedCues = merged;
      }
    }

    if (
      token !== state.loadingToken ||
      videoId !== state.videoId ||
      trackFingerprint !== state.trackFingerprint
    ) {
      return;
    }

    state.cues = preparedCues;
    if (segmentationFallbackMessage) {
      setStatus(`LLM 智能断句失败，已回退本地断句：${segmentationFallbackMessage}`);
    } else {
      setStatus(`正在预翻译字幕 0/${preparedCues.length}...`);
    }
    scheduleTranslations(getCurrentTimeMs(), true);
  }

  async function fetchCaptionData(track, videoId, transcript) {
    const errors = [];
    let resolvedTranscript = transcript;

    if (track && track.baseUrl) {
      try {
        return await fetchCaptionTrack(track, videoId);
      } catch (error) {
        errors.push(`timedtext: ${error.message || String(error)}`);
        if (hasTranscriptApi(resolvedTranscript)) {
          setStatus("字幕轨道返回空内容，正在尝试 YouTube transcript...");
        }
      }
    }

    if (hasTranscriptApi(resolvedTranscript)) {
      try {
        setStatus("页面字幕为空，正在尝试 Innertube player 字幕轨道...");
        const innertubeTracks = await fetchInnertubePlayerCaptionTracks(videoId, resolvedTranscript.apiKey);
        const innertubeTrack = selectSourceTrack(innertubeTracks);
        if (innertubeTrack) {
          return await fetchCaptionTrack(innertubeTrack, videoId);
        }
        errors.push("innertube player: no English caption track");
      } catch (error) {
        errors.push(`innertube player: ${error.message || String(error)}`);
      }
    }

    if (hasTranscriptApi(resolvedTranscript) && !hasTranscriptParams(resolvedTranscript)) {
      try {
        setStatus("正在查找 YouTube transcript 参数...");
        resolvedTranscript = await fetchTranscriptParamsFromNext(videoId, resolvedTranscript);
      } catch (error) {
        errors.push(`transcript params: ${error.message || String(error)}`);
      }
    }

    if (hasTranscriptParams(resolvedTranscript)) {
      try {
        return await fetchTranscriptTrack(resolvedTranscript);
      } catch (error) {
        errors.push(`transcript: ${error.message || String(error)}`);
      }
    }

    throw new Error(errors.join("; ") || "No caption source is available.");
  }

  async function fetchCaptionTrack(track, videoId) {
    const attempts = [
      {
        label: "json3",
        format: "json3",
        parse: (text) => Core.parseJson3Captions(parseCaptionJson(text))
      },
      {
        label: "vtt",
        format: "vtt",
        parse: (text) => Core.parseVttCaptions(text)
      },
      {
        label: "srv3",
        format: "srv3",
        parse: (text) => Core.parseXmlCaptions(text)
      },
      {
        label: "ttml",
        format: "ttml",
        parse: (text) => Core.parseXmlCaptions(text)
      },
      {
        label: "original",
        format: null,
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed.startsWith("{")) {
            return Core.parseJson3Captions(parseCaptionJson(trimmed));
          }
          if (trimmed.startsWith("WEBVTT")) {
            return Core.parseVttCaptions(trimmed);
          }
          return Core.parseXmlCaptions(trimmed);
        }
      }
    ];

    const errors = [];
    const baseUrls = buildCaptionBaseUrls(track, videoId);

    for (let urlIndex = 0; urlIndex < baseUrls.length; urlIndex += 1) {
      const baseUrl = baseUrls[urlIndex];
      const sourceLabel = urlIndex === 0 ? "player" : `legacy${urlIndex}`;

      for (const attempt of attempts) {
        try {
          const label = `${sourceLabel}/${attempt.label}`;
          const captionText = await fetchCaptionText(baseUrl, attempt.format, label);
          const cues = attempt.parse(captionText);
          if (cues.length) {
            return cues;
          }
          errors.push(`${label}: no cues`);
        } catch (error) {
          errors.push(`${sourceLabel}/${attempt.label}: ${error.message || String(error)}`);
        }
      }
    }

    throw new Error(`No usable captions found (${errors.join("; ")}).`);
  }

  function parseCaptionJson(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      throw new Error("empty response");
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`invalid JSON (${error.message || String(error)})`);
    }
  }

  function buildCaptionBaseUrls(track, videoId) {
    const urls = [];
    addCaptionUrl(urls, normalizeCaptionBaseUrl(track.baseUrl));

    const languageCode = String(track.languageCode || "en").trim() || "en";
    const languages = languageCode.toLowerCase().startsWith("en-")
      ? [languageCode, "en"]
      : [languageCode];
    const inferredKind = String(track.kind || "").trim() || (String(track.vssId || "").startsWith("a.") ? "asr" : "");

    if (videoId) {
      for (const language of languages) {
        addCaptionUrl(urls, buildLegacyCaptionUrl(videoId, language, inferredKind));
        addCaptionUrl(urls, buildLegacyCaptionUrl(videoId, language, ""));
      }
    }

    return urls;
  }

  function normalizeCaptionBaseUrl(baseUrl) {
    try {
      const url = new URL(baseUrl, window.location.href);
      url.searchParams.delete("fmt");
      url.searchParams.delete("tlang");
      if (!url.searchParams.has("c")) {
        url.searchParams.set("c", "WEB");
      }
      return url.toString();
    } catch (error) {
      return baseUrl || "";
    }
  }

  function buildLegacyCaptionUrl(videoId, languageCode, kind) {
    const url = new URL("https://www.youtube.com/api/timedtext");
    url.searchParams.set("v", videoId);
    url.searchParams.set("lang", languageCode);
    url.searchParams.set("type", "track");
    url.searchParams.set("c", "WEB");
    if (kind) {
      url.searchParams.set("kind", kind);
    }
    return url.toString();
  }

  function addCaptionUrl(urls, url) {
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }

  async function fetchInnertubePlayerCaptionTracks(videoId, apiKey) {
    const url = new URL("https://www.youtube.com/youtubei/v1/player");
    url.searchParams.set("prettyPrint", "false");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38"
          }
        },
        videoId
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`player request failed (${response.status}): ${text.slice(0, 160)}`);
    }

    const json = parseCaptionJson(text);
    const renderer =
      json &&
      json.captions &&
      json.captions.playerCaptionsTracklistRenderer;
    const tracks = renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];

    return tracks.map((track) => ({
      baseUrl: track.baseUrl || "",
      languageCode: track.languageCode || "",
      kind: track.kind || "",
      vssId: track.vssId || "",
      name: textFromCaptionName(track.name),
      isTranslatable: Boolean(track.isTranslatable)
    }));
  }

  function textFromCaptionName(name) {
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

  async function fetchCaptionText(baseUrl, format, label) {
    const url = captionUrlWithFormat(baseUrl, format);
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: format === "json3" ? "application/json,text/plain,*/*" : "*/*"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Timedtext request failed (${response.status})`);
    }
    if (!text.trim()) {
      throw new Error(`${label || format || "caption"} returned empty response`);
    }
    return text;
  }

  function captionUrlWithFormat(baseUrl, format) {
    const url = new URL(baseUrl, window.location.href);
    if (format) {
      url.searchParams.set("fmt", format);
    }
    return url.toString();
  }

  function hasTranscriptApi(transcript) {
    return Boolean(transcript && transcript.apiKey);
  }

  function hasTranscriptParams(transcript) {
    return Boolean(transcript && transcript.params && transcript.apiKey);
  }

  async function fetchTranscriptParamsFromNext(videoId, transcript) {
    const url = new URL("https://www.youtube.com/youtubei/v1/next");
    url.searchParams.set("prettyPrint", "false");
    url.searchParams.set("key", transcript.apiKey);

    const response = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: buildInnertubeHeaders(transcript),
      body: JSON.stringify({
        context: transcript.context || {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240601.00.00"
          }
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`next request failed (${response.status}): ${text.slice(0, 160)}`);
    }

    const json = parseCaptionJson(text);
    const params = Core.findYouTubeTranscriptParams(json, 0);
    if (!params) {
      throw new Error("next response did not include transcript params");
    }

    return Object.assign({}, transcript, { params });
  }

  async function fetchTranscriptTrack(transcript) {
    const url = new URL("https://www.youtube.com/youtubei/v1/get_transcript");
    url.searchParams.set("prettyPrint", "false");
    url.searchParams.set("key", transcript.apiKey);

    const response = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: buildInnertubeHeaders(transcript),
      body: JSON.stringify({
        context: transcript.context || {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240601.00.00"
          }
        },
        params: transcript.params
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Transcript request failed (${response.status}): ${text.slice(0, 160)}`);
    }
    const json = parseCaptionJson(text);
    const cues = Core.parseYouTubeTranscriptResponse(json);
    if (!cues.length) {
      throw new Error("Transcript response did not contain segments");
    }
    return cues;
  }

  function buildInnertubeHeaders(transcript) {
    const headers = {
      "Content-Type": "application/json"
    };
    if (transcript.clientName) {
      headers["X-YouTube-Client-Name"] = String(transcript.clientName);
    }
    if (transcript.clientVersion) {
      headers["X-YouTube-Client-Version"] = String(transcript.clientVersion);
    }
    if (transcript.visitorData || (transcript.context && transcript.context.client && transcript.context.client.visitorData)) {
      headers["X-Goog-Visitor-Id"] = String(
        transcript.visitorData || transcript.context.client.visitorData
      );
    }
    headers["X-Origin"] = "https://www.youtube.com";
    return headers;
  }

  function formatCaptionLoadError(error) {
    const message = error && error.message ? error.message : String(error);
    if (message.includes("returned empty response") || message.includes("No usable captions found")) {
      return "YouTube 返回空字幕数据；已尝试 timedtext 和 transcript。请确认原生 CC 能显示英文字幕，或换一个有英文字幕的视频测试。";
    }
    return message;
  }

  function scheduleTranslations(anchorMs, resetQueue) {
    if (!state.settings.subtitleEnabled || !state.cues.length) {
      return;
    }

    if (!hasApiKey()) {
      setStatus(`${missingApiConfigText()}。`);
      return;
    }

    if (resetQueue) {
      state.queue = [];
    }

    const alreadyQueued = new Set();
    for (const batch of state.queue) {
      for (const cue of batch.cues) {
        alreadyQueued.add(cue.id);
      }
    }
    for (const batch of state.inFlight.values()) {
      for (const cue of batch.cues) {
        alreadyQueued.add(cue.id);
      }
    }

    const pending = state.cues
      .filter((cue) => cue.status === "pending" && !alreadyQueued.has(cue.id))
      .sort((left, right) => priorityScore(left, anchorMs) - priorityScore(right, anchorMs));

    const batchSize = currentBatchSize();
    for (let index = 0; index < pending.length; index += batchSize) {
      state.queue.push({ cues: pending.slice(index, index + batchSize) });
    }

    pumpQueue();
  }

  function priorityScore(cue, anchorMs) {
    if (cue.endMs >= anchorMs && cue.startMs <= anchorMs + PRIORITY_WINDOW_MS) {
      return Math.abs(cue.startMs - anchorMs);
    }
    if (cue.startMs > anchorMs + PRIORITY_WINDOW_MS) {
      return PRIORITY_WINDOW_MS + cue.startMs - anchorMs;
    }
    return PRIORITY_WINDOW_MS * 10 + (anchorMs - cue.endMs);
  }

  function pumpQueue() {
    if (state.pumping || !state.settings.subtitleEnabled || !hasApiKey()) {
      return;
    }

    if (isInApiBackoff()) {
      scheduleApiBackoffTimer();
      setStatus(formatApiBackoffStatus());
      return;
    }

    state.pumping = true;
    try {
      while (state.inFlight.size < currentMaxParallelBatches() && state.queue.length) {
        const queued = state.queue.shift();
        const cues = queued.cues.filter((cue) => cue.status === "pending");
        if (!cues.length) {
          continue;
        }

        const batch = {
          id: `${state.videoId}:${state.trackFingerprint}:${Date.now()}:${state.batchSerial += 1}`,
          videoId: state.videoId,
          trackFingerprint: state.trackFingerprint,
          cues
        };

        for (const cue of cues) {
          cue.status = "translating";
        }

        state.inFlight.set(batch.id, batch);
        sendTranslationBatch(batch);
      }
      updateProgressStatus();
    } finally {
      state.pumping = false;
    }
  }

  async function sendTranslationBatch(batch) {
    try {
      const response = await sendMessage({
        type: "TRANSLATE_BATCH",
        batchId: batch.id,
        videoId: batch.videoId,
        trackFingerprint: batch.trackFingerprint,
        cues: batch.cues.map((cue) => ({
          id: cue.id,
          sourceText: cue.sourceText
        }))
      });

      const currentBatch = state.inFlight.get(batch.id);
      state.inFlight.delete(batch.id);

      if (!currentBatch || currentBatch.videoId !== state.videoId || currentBatch.trackFingerprint !== state.trackFingerprint) {
        pumpQueue();
        return;
      }

      if (!response || response.ok === false) {
        const error = response && response.errors && response.errors[0];
        const message = error && error.message ? error.message : "翻译失败";
        if (splitBatchOnTruncation(currentBatch, message)) {
          // Cues already re-queued in smaller batches; skip per-cue retry path.
        } else {
          handleBatchFailure(currentBatch, message);
        }
      } else {
        applyTranslations(currentBatch, response.items || []);
      }
    } catch (error) {
      const currentBatch = state.inFlight.get(batch.id);
      state.inFlight.delete(batch.id);

      if (!currentBatch || currentBatch.videoId !== state.videoId || currentBatch.trackFingerprint !== state.trackFingerprint) {
        pumpQueue();
        return;
      }

      const message = error.message || String(error);
      if (splitBatchOnTruncation(currentBatch, message)) {
        // Cues already re-queued in smaller batches; skip per-cue retry path.
      } else {
        handleBatchFailure(currentBatch, message);
      }
    }

    updateProgressStatus();
    pumpQueue();
  }

  function sendMessage(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const requestTimeoutMs = Number(timeoutMs) || TRANSLATION_MESSAGE_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        settled = true;
        reject(new Error(`LLM request timeout: background worker did not respond within ${Math.round(requestTimeoutMs / 1000)} seconds.`));
      }, requestTimeoutMs);

      chrome.runtime.sendMessage(message, (response) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function applyTranslations(batch, items) {
    const translatedById = new Map();
    for (const item of items) {
      if (item && item.id != null && item.translatedText) {
        translatedById.set(String(item.id), {
          translatedText: Core.normalizeSubtitleText(item.translatedText),
          displaySourceText: Core.normalizeSubtitleText(item.displaySourceText || "")
        });
      }
    }

    for (const cue of batch.cues) {
      const translation = translatedById.get(String(cue.id));
      if (translation && translation.translatedText) {
        if (translation.displaySourceText) {
          cue.displaySourceText = translation.displaySourceText;
        }
        cue.translatedText = translation.translatedText;
        cue.status = "translated";
        cue.translationRetryCount = 0;
      } else {
        queueCueTranslationRetry(cue, "Translation API did not return this cue.");
      }
    }
  }

  function handleBatchFailure(batch, message) {
    const retryable = isRetryableTranslationError(message);
    const backoffMs = retryable ? apiBackoffMsForError(message) : 0;

    if (backoffMs && requeueBatchForBackoff(batch, message)) {
      applyApiBackoff(message, backoffMs);
      return;
    }

    for (const cue of batch.cues) {
      if (cue.status === "translating") {
        if (retryable && queueCueTranslationRetry(cue, message)) {
          continue;
        }
        cue.status = "failed";
        cue.lastError = message;
      }
    }
    setStatus(message.includes("API Key") ? `${missingApiConfigText()}。` : `翻译失败：${message}`);
  }

  function queueCueTranslationRetry(cue, message) {
    cue.translationRetryCount = Number(cue.translationRetryCount || 0) + 1;
    cue.lastError = message;

    if (cue.translationRetryCount > MAX_CUE_TRANSLATION_RETRIES) {
      cue.status = "failed";
      return false;
    }

    cue.status = "pending";
    enqueueRetryCues([cue]);
    return true;
  }

  function enqueueRetryCues(cues) {
    const retryCues = cues.filter((cue) => cue && cue.status === "pending");
    const retryBatchSize = currentRetryBatchSize();
    for (let index = retryCues.length; index > 0; index -= retryBatchSize) {
      const start = Math.max(0, index - retryBatchSize);
      state.queue.unshift({ cues: retryCues.slice(start, index) });
    }
  }

  function isRetryableTranslationError(message) {
    return Core.classifyTranslationError(message) === "retryable";
  }

  function currentTranslationConfig() {
    return Core.resolveTranslationConfig(state.settings);
  }

  function isGeminiProvider() {
    return currentTranslationConfig().apiStyle === "gemini";
  }

  function isCustomOpenAiProvider() {
    return currentTranslationConfig().provider === "custom";
  }

  function currentBatchSize() {
    if (isGeminiProvider()) {
      return GEMINI_BATCH_SIZE;
    }
    return isCustomOpenAiProvider() ? CUSTOM_BATCH_SIZE : BATCH_SIZE;
  }

  function currentRetryBatchSize() {
    if (isGeminiProvider()) {
      return GEMINI_RETRY_BATCH_SIZE;
    }
    return isCustomOpenAiProvider() ? CUSTOM_RETRY_BATCH_SIZE : RETRY_BATCH_SIZE;
  }

  function currentMaxParallelBatches() {
    if (isGeminiProvider()) {
      return GEMINI_MAX_PARALLEL_BATCHES;
    }
    return isCustomOpenAiProvider() ? CUSTOM_MAX_PARALLEL_BATCHES : MAX_PARALLEL_BATCHES;
  }

  function requeueBatchForBackoff(batch, message) {
    const eligible = [];
    for (const cue of batch.cues) {
      if (cue.status === "translating") {
        cue.lastError = message;
        cue.status = "pending";
        eligible.push(cue);
      }
    }
    if (!eligible.length) {
      return false;
    }
    enqueueRetryCues(eligible);
    return true;
  }

  function apiBackoffMsForError(message) {
    const text = String(message || "");
    if (/429|TooManyRequests|too many requests|rate limit/i.test(text)) {
      return RATE_LIMIT_BACKOFF_MS;
    }
    if (/503|ServiceUnavailable|unavailable/i.test(text)) {
      return SERVICE_BACKOFF_MS;
    }
    if (/timeout|aborted|network|failed to fetch/i.test(text)) {
      return DEFAULT_API_BACKOFF_MS;
    }
    return 0;
  }

  function applyApiBackoff(message, backoffMs) {
    state.apiBackoffUntil = Math.max(state.apiBackoffUntil || 0, Date.now() + backoffMs);
    state.apiBackoffMessage = simplifyTranslationError(message);
    scheduleApiBackoffTimer();
    setStatus(formatApiBackoffStatus());
  }

  function isInApiBackoff() {
    return state.apiBackoffUntil && Date.now() < state.apiBackoffUntil;
  }

  function scheduleApiBackoffTimer() {
    if (state.apiBackoffTimer) {
      clearTimeout(state.apiBackoffTimer);
    }

    const remainingMs = Math.max(0, (state.apiBackoffUntil || 0) - Date.now());
    if (!remainingMs) {
      state.apiBackoffUntil = 0;
      state.apiBackoffMessage = "";
      state.apiBackoffTimer = null;
      return;
    }

    state.apiBackoffTimer = setTimeout(() => {
      state.apiBackoffTimer = null;
      if (isInApiBackoff()) {
        scheduleApiBackoffTimer();
        setStatus(formatApiBackoffStatus());
        return;
      }
      state.apiBackoffUntil = 0;
      state.apiBackoffMessage = "";
      updateProgressStatus();
      pumpQueue();
    }, Math.min(remainingMs, 60000));
  }

  function formatApiBackoffStatus() {
    const seconds = Math.max(1, Math.ceil(((state.apiBackoffUntil || 0) - Date.now()) / 1000));
    const detail = state.apiBackoffMessage ? `：${state.apiBackoffMessage}` : "";
    return `API 请求过快，暂停 ${seconds} 秒后自动重试${detail}`;
  }

  // When the upstream model truncates a batch (finish_reason=length), re-queue
  // the affected cues in much smaller chunks (RETRY_BATCH_SIZE) so the next
  // attempt fits within the token budget, instead of retrying the same oversized
  // batch and looping. Returns true when the split was applied.
  function splitBatchOnTruncation(batch, message) {
    if (!/truncated|finish_reason|MAX_TOKENS/i.test(String(message || ""))) {
      return false;
    }
    const eligible = [];
    for (const cue of batch.cues) {
      if (cue.status === "translating") {
        cue.translationRetryCount = Number(cue.translationRetryCount || 0);
        cue.status = "pending";
        eligible.push(cue);
      }
    }
    if (!eligible.length) {
      return false;
    }
    enqueueRetryCues(eligible);
    return true;
  }

  function updateProgressStatus() {
    if (!state.cues.length) {
      return;
    }

    const done = state.cues.filter((cue) => cue.status === "translated").length;
    const failed = state.cues.filter((cue) => cue.status === "failed").length;
    const translating = state.cues.filter((cue) => cue.status === "translating").length;
    const total = state.cues.length;

    if (done === total) {
      setStatus("");
    } else if (failed) {
      const failedCue = state.cues.find((cue) => cue.status === "failed" && cue.lastError);
      const detail = failedCue ? `：${simplifyTranslationError(failedCue.lastError)}` : "";
      setStatus(`部分字幕翻译失败，已完成 ${done}/${total}，失败 ${failed}${detail}`);
    } else if (translating) {
      setStatus(`正在翻译字幕 ${done}/${total}（${translating} 条处理中）...`);
    } else {
      setStatus(`正在预翻译字幕 ${done}/${total}...`);
    }
  }

  function hasApiKey() {
    const config = Core.resolveTranslationConfig(state.settings);
    const endpointUrl =
      config.apiStyle === "gemini"
        ? config.generateContentUrl
        : config.chatCompletionsUrl;
    return Boolean(config.apiKey && endpointUrl && config.model);
  }

  function watchVideoElement() {
    const video = document.querySelector("video");
    if (video === state.video) {
      return;
    }

    if (state.video) {
      state.video.removeEventListener("seeked", handleSeek);
      state.video.removeEventListener("loadedmetadata", handleSeek);
    }

    state.video = video;
    if (state.video) {
      state.video.addEventListener("seeked", handleSeek);
      state.video.addEventListener("loadedmetadata", handleSeek);
      disableBrowserTextTracks();
    }
  }

  function handleSeek() {
    scheduleTranslations(getCurrentTimeMs(), true);
  }

  function getCurrentTimeMs() {
    const video = state.video || document.querySelector("video");
    if (!video || !Number.isFinite(video.currentTime)) {
      return 0;
    }
    return video.currentTime * 1000;
  }

  function getUrlVideoId() {
    try {
      return new URL(window.location.href).searchParams.get("v") || "";
    } catch (error) {
      return "";
    }
  }

  function syncVideoWithLocation() {
    const urlVideoId = getUrlVideoId();
    if (!urlVideoId || urlVideoId === state.videoId) {
      return;
    }

    const transcript =
      state.transcript ||
      (state.lastPlayerResponse && state.lastPlayerResponse.transcript) ||
      null;
    const trackFingerprint = makeStableTrackFingerprint(urlVideoId, null, transcript);

    resetVideoState(urlVideoId, null, trackFingerprint, transcript);
    state.lastPlayerResponse = null;
    setStatus("正在切换视频并读取字幕...");
    requestPlayerResponse();

    if (hasTranscriptApi(transcript)) {
      loadCaptionTrack(urlVideoId, null, trackFingerprint, transcript);
    }
  }

  function renderLoop() {
    syncVideoWithLocation();
    ensureOverlay();
    updateNativeCaptionBlocking();
    updateOverlay();
    requestAnimationFrame(renderLoop);
  }

  function startNativeCaptionBlocker() {
    if (state.nativeCaptionObserver) {
      return;
    }

    state.nativeCaptionObserver = new MutationObserver((mutations) => {
      if (!state.settings.subtitleEnabled) {
        return;
      }

      for (const mutation of mutations) {
        if (mutation.type !== "childList") {
          continue;
        }
        for (const node of mutation.addedNodes) {
          hideNativeCaptionNodeTree(node);
        }
      }
    });

    const root = document.documentElement || document.body;
    if (root) {
      state.nativeCaptionObserver.observe(root, {
        childList: true,
        subtree: true
      });
    }
    updateNativeCaptionBlocking(true);
  }

  function updateNativeCaptionBlocking(force) {
    if (!force && Date.now() - state.lastNativeCaptionSweepAt < 250) {
      return;
    }
    state.lastNativeCaptionSweepAt = Date.now();

    if (state.settings.subtitleEnabled) {
      requestDisableNativeCaptions(Boolean(force));
      hideNativeCaptionNodeTree(document);
      hideCaptionLikePlayerOverlays();
      disableBrowserTextTracks();
    } else {
      restoreNativeCaptionNodes();
    }
  }

  function hideNativeCaptionNodeTree(root) {
    if (!root || !state.settings.subtitleEnabled) {
      return;
    }

    const nodes = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches && root.matches(NATIVE_CAPTION_SELECTOR)) {
      nodes.push(root);
    }
    if (root.querySelectorAll) {
      nodes.push(...root.querySelectorAll(NATIVE_CAPTION_SELECTOR));
    }

    for (const node of nodes) {
      if (state.overlay && (node === state.overlay || state.overlay.contains(node))) {
        continue;
      }
      node.dataset.ytbtNativeCaptionHidden = "true";
      node.style.setProperty("display", "none", "important");
      node.style.setProperty("visibility", "hidden", "important");
      node.style.setProperty("opacity", "0", "important");
      node.style.setProperty("pointer-events", "none", "important");
    }
  }

  function hideCaptionLikePlayerOverlays() {
    const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
    if (!player) {
      return;
    }

    const playerRect = player.getBoundingClientRect();
    if (!playerRect.width || !playerRect.height) {
      return;
    }

    const candidates = new Set([
      ...player.querySelectorAll("div, span, p"),
      ...document.querySelectorAll(
        "body div[style], body span[style], body p[style], body [class*='caption' i], body [class*='subtitle' i]"
      )
    ]);
    for (const node of candidates) {
      if (!isLikelyNativeCaptionOverlay(node, playerRect)) {
        continue;
      }
      node.dataset.ytbtNativeCaptionHidden = "true";
      node.style.setProperty("display", "none", "important");
      node.style.setProperty("visibility", "hidden", "important");
      node.style.setProperty("opacity", "0", "important");
      node.style.setProperty("pointer-events", "none", "important");
    }
  }

  function isLikelyNativeCaptionOverlay(node, playerRect) {
    if (!node || !state.settings.subtitleEnabled) {
      return false;
    }
    if (node.closest(".ytbt-overlay")) {
      return false;
    }
    if (node.closest("#masthead, ytd-app, ytd-watch-metadata, ytd-comments, ytd-engagement-panel-section-list-renderer") && !node.closest(".html5-video-player, #movie_player")) {
      return false;
    }
    if (node.closest(".ytp-chrome-bottom, .ytp-chrome-top, .ytp-gradient-bottom, .ytp-gradient-top, .ytp-progress-bar-container, .ytp-tooltip, .ytp-popup, .ytp-ce-element")) {
      return false;
    }
    if (node.querySelector("button, a, svg, input, textarea, select")) {
      return false;
    }

    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 18) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return false;
    }
    if (!rectOverlapsPlayer(rect, playerRect)) {
      return false;
    }
    if (rect.width < playerRect.width * 0.18 || rect.height < 12) {
      return false;
    }
    if (rect.bottom < playerRect.top + playerRect.height * 0.32) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const positionLooksOverlay = style.position === "absolute" || style.position === "fixed";
    const highLayer = Number.parseInt(style.zIndex, 10);
    const fontSize = Number.parseFloat(style.fontSize);
    const hasCaptionishStyle =
      style.textShadow !== "none" ||
      style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
      style.webkitTextStrokeWidth !== "0px" ||
      textLooksLikeActiveCue(text);

    return (
      (positionLooksOverlay || textLooksLikeActiveCue(text)) &&
      (Number.isFinite(highLayer) ? highLayer >= 0 : true) &&
      Number.isFinite(fontSize) &&
      fontSize >= 12 &&
      hasCaptionishStyle
    );
  }

  function rectOverlapsPlayer(rect, playerRect) {
    const horizontallyOverlaps = rect.right > playerRect.left && rect.left < playerRect.right;
    const verticallyOverlaps = rect.bottom > playerRect.top + playerRect.height * 0.25 && rect.top < playerRect.bottom;
    return horizontallyOverlaps && verticallyOverlaps;
  }

  function textLooksLikeActiveCue(text) {
    const cue = Core.findCueAtTime(state.cues, getCurrentTimeMs());
    if (!cue) {
      return false;
    }

    const normalizedText = Core.normalizeSubtitleText(text).toLowerCase();
    const sourceText = Core.normalizeSubtitleText(cue.displaySourceText || cue.sourceText || "").toLowerCase();
    const translatedText = Core.normalizeSubtitleText(cue.translatedText || "").toLowerCase();

    return textPairLooksRelated(normalizedText, sourceText) || textPairLooksRelated(normalizedText, translatedText);
  }

  function textPairLooksRelated(left, right) {
    if (!left || !right) {
      return false;
    }

    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    if (shorter.length < 12) {
      return false;
    }

    return longer.includes(shorter.slice(0, Math.min(48, shorter.length)));
  }

  function restoreNativeCaptionNodes() {
    for (const node of document.querySelectorAll('[data-ytbt-native-caption-hidden="true"]')) {
      delete node.dataset.ytbtNativeCaptionHidden;
      node.style.removeProperty("display");
      node.style.removeProperty("visibility");
      node.style.removeProperty("opacity");
      node.style.removeProperty("pointer-events");
    }
  }

  function requestDisableNativeCaptions(force) {
    if (!state.settings.subtitleEnabled) {
      return;
    }

    const now = Date.now();
    if (!force && now - state.lastNativeCaptionDisableRequestAt < 900) {
      return;
    }
    state.lastNativeCaptionDisableRequestAt = now;

    try {
      const subtitleButton = document.querySelector(".ytp-subtitles-button");
      if (subtitleButton && subtitleButton.getAttribute("aria-pressed") === "true") {
        subtitleButton.click();
      }
    } catch (error) {
      // Ignore transient YouTube UI state.
    }

    window.postMessage(
      {
        channel: CHANNEL,
        type: "DISABLE_NATIVE_CAPTIONS"
      },
      window.location.origin
    );
  }

  function disableBrowserTextTracks() {
    const video = state.video || document.querySelector("video");
    if (!video || !video.textTracks) {
      return;
    }

    for (const track of video.textTracks) {
      if (track && track.mode !== "disabled") {
        track.mode = "disabled";
      }
    }
  }

  function ensureOverlay() {
    const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
    if (!player) {
      return null;
    }

    if (state.overlay && state.overlay.parentElement === player) {
      return state.overlay;
    }

    const overlay = state.overlay || document.createElement("div");
    overlay.className = "ytbt-overlay ytbt-no-cue ytbt-no-status";
    overlay.setAttribute("aria-live", "polite");
    overlay.style.setProperty("--ytbt-font-scale", String(state.settings.fontScale));
    overlay.innerHTML = [
      '<div class="ytbt-lines">',
      '  <div class="ytbt-cn"></div>',
      '  <div class="ytbt-en"></div>',
      "</div>",
      '<div class="ytbt-status"></div>'
    ].join("");

    state.overlay = overlay;
    state.overlayParts = {
      cn: overlay.querySelector(".ytbt-cn"),
      en: overlay.querySelector(".ytbt-en"),
      status: overlay.querySelector(".ytbt-status")
    };
    bindOverlayDragHandlers(overlay);
    player.appendChild(overlay);
    applySettings();
    return overlay;
  }

  function bindOverlayDragHandlers(overlay) {
    if (!overlay || overlay.dataset.ytbtDragBound === "true") {
      return;
    }

    overlay.dataset.ytbtDragBound = "true";
    overlay.addEventListener("pointerdown", handleOverlayPointerDown, true);
    for (const surface of overlay.querySelectorAll(".ytbt-lines, .ytbt-status")) {
      surface.addEventListener("pointerdown", handleOverlayPointerDown, true);
    }
  }

  function handleOverlayPointerDown(event) {
    if (!state.settings.subtitleEnabled || !state.overlay) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (!event.target.closest(".ytbt-lines, .ytbt-status")) {
      return;
    }
    if (state.overlayDrag.pointerId != null) {
      cancelOverlayDrag();
    }

    event.preventDefault();
    event.stopPropagation();
    clearOverlayDragTimer();

    const drag = state.overlayDrag;
    drag.pointerId = event.pointerId;
    drag.active = false;
    drag.startClientX = event.clientX;
    drag.startClientY = event.clientY;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    setOverlayDragOffsets(event.clientX, event.clientY);

    document.addEventListener("pointermove", handleOverlayPointerMove, true);
    document.addEventListener("pointerup", handleOverlayPointerUp, true);
    document.addEventListener("pointercancel", handleOverlayPointerCancel, true);
    document.addEventListener("mouseup", handleOverlayMouseUpFallback, true);

    drag.timer = setTimeout(() => {
      startOverlayDrag();
    }, DRAG_LONG_PRESS_MS);
  }

  function setOverlayDragOffsets(clientX, clientY) {
    if (!state.overlay) {
      return;
    }

    const overlayRect = state.overlay.getBoundingClientRect();
    state.overlayDrag.offsetX = clientX - overlayRect.left;
    state.overlayDrag.offsetY = clientY - overlayRect.top;
  }

  function startOverlayDrag() {
    if (!state.overlay || state.overlayDrag.pointerId == null) {
      return;
    }

    state.overlayDrag.active = true;
    state.overlay.classList.add("ytbt-dragging");
    moveOverlayToPointer(state.overlayDrag.lastClientX, state.overlayDrag.lastClientY);
  }

  function handleOverlayPointerMove(event) {
    const drag = state.overlayDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;

    if (!drag.active) {
      return;
    }

    moveOverlayToPointer(event.clientX, event.clientY);
  }

  function handleOverlayPointerUp(event) {
    if (state.overlayDrag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const wasDragging = state.overlayDrag.active;
    if (wasDragging) {
      saveOverlayPosition();
    }
    cancelOverlayDrag();
  }

  function handleOverlayPointerCancel(event) {
    if (event && state.overlayDrag.pointerId !== event.pointerId) {
      return;
    }
    cancelOverlayDrag();
  }

  function handleOverlayMouseUpFallback(event) {
    if (state.overlayDrag.pointerId == null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (state.overlayDrag.active) {
      saveOverlayPosition();
    }
    cancelOverlayDrag();
  }

  function moveOverlayToPointer(clientX, clientY) {
    const player = getOverlayPlayer();
    if (!player || !state.overlay) {
      return;
    }

    const playerRect = player.getBoundingClientRect();
    const overlayRect = state.overlay.getBoundingClientRect();
    if (!playerRect.width || !playerRect.height || !overlayRect.width || !overlayRect.height) {
      return;
    }

    const centerX = clientX - state.overlayDrag.offsetX + overlayRect.width / 2;
    const centerY = clientY - state.overlayDrag.offsetY + overlayRect.height / 2;
    const minX = playerRect.left + overlayRect.width / 2 + DRAG_EDGE_PADDING_PX;
    const maxX = playerRect.right - overlayRect.width / 2 - DRAG_EDGE_PADDING_PX;
    const minY = playerRect.top + overlayRect.height / 2 + DRAG_EDGE_PADDING_PX;
    const maxY = playerRect.bottom - overlayRect.height / 2 - DRAG_EDGE_PADDING_PX;
    const clampedX = clamp(centerX, Math.min(minX, maxX), Math.max(minX, maxX));
    const clampedY = clamp(centerY, Math.min(minY, maxY), Math.max(minY, maxY));

    state.settings.subtitlePosition = {
      xPct: ((clampedX - playerRect.left) / playerRect.width) * 100,
      yPct: ((clampedY - playerRect.top) / playerRect.height) * 100
    };
    applyOverlayPosition();
  }

  async function saveOverlayPosition() {
    const position = normalizeSubtitlePosition(state.settings.subtitlePosition);
    if (!position) {
      return;
    }
    state.settings.subtitlePosition = position;
    await storageSet({ subtitlePosition: position });
  }

  function cancelOverlayDrag() {
    clearOverlayDragTimer();
    document.removeEventListener("pointermove", handleOverlayPointerMove, true);
    document.removeEventListener("pointerup", handleOverlayPointerUp, true);
    document.removeEventListener("pointercancel", handleOverlayPointerCancel, true);
    document.removeEventListener("mouseup", handleOverlayMouseUpFallback, true);

    if (state.overlay) {
      state.overlay.classList.remove("ytbt-dragging");
    }

    state.overlayDrag.pointerId = null;
    state.overlayDrag.active = false;
  }

  function clearOverlayDragTimer() {
    if (state.overlayDrag.timer) {
      clearTimeout(state.overlayDrag.timer);
      state.overlayDrag.timer = null;
    }
  }

  function applyOverlayPosition() {
    if (!state.overlay) {
      return;
    }

    const position = normalizeSubtitlePosition(state.settings.subtitlePosition);
    if (!position) {
      state.overlay.style.left = "50%";
      state.overlay.style.top = "";
      state.overlay.style.bottom = "calc(8% + 44px)";
      state.overlay.style.transform = "translateX(-50%)";
      return;
    }

    state.overlay.style.left = `${position.xPct}%`;
    state.overlay.style.top = `${position.yPct}%`;
    state.overlay.style.bottom = "auto";
    state.overlay.style.transform = "translate(-50%, -50%)";
  }

  function getOverlayPlayer() {
    return (
      (state.overlay && state.overlay.parentElement && state.overlay.parentElement.closest(".html5-video-player, #movie_player")) ||
      document.querySelector(".html5-video-player") ||
      document.querySelector("#movie_player")
    );
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function updateOverlay() {
    const overlay = state.overlay;
    const parts = state.overlayParts;
    if (!overlay || !parts) {
      return;
    }

    if (!state.settings.subtitleEnabled) {
      overlay.hidden = true;
      return;
    }

    const timeMs = getCurrentTimeMs();
    const cue = Core.findCueAtTime(state.cues, timeMs);
    const hasCue = Boolean(cue);
    const statusText = hasCue ? "" : state.statusText;

    overlay.hidden = false;
    overlay.classList.toggle("ytbt-no-cue", !hasCue);
    overlay.classList.toggle("ytbt-no-status", !statusText);
    overlay.classList.toggle("ytbt-loading", hasCue && cue.status !== "translated");

    if (hasCue) {
      parts.cn.textContent = cue.translatedText || fallbackTextForCue(cue);
      parts.en.textContent = cue.displaySourceText || cue.sourceText || "";

      if (cue.status === "pending" && Date.now() - state.lastUrgentScheduleAt > URGENT_RESCHEDULE_MS) {
        state.lastUrgentScheduleAt = Date.now();
        scheduleTranslations(timeMs, true);
      }
    } else {
      parts.cn.textContent = "";
      parts.en.textContent = "";
    }

    parts.status.textContent = statusText;
  }

  function fallbackTextForCue(cue) {
    if (!hasApiKey()) {
      return missingApiConfigText();
    }
    if (cue.status === "failed") {
      return formatCueFailureText(cue.lastError);
    }
    return "翻译中...";
  }

  function formatCueFailureText(message) {
    const detail = simplifyTranslationError(message);
    return detail ? `翻译失败：${detail}` : "翻译失败";
  }

  function simplifyTranslationError(message) {
    const text = Core.normalizeSubtitleText(message || "");
    if (!text) {
      return "";
    }

    return text
      .replace(/^Error:\s*/i, "")
      .replace(/^Gemini request failed \((\d+)\):\s*/i, "Gemini $1：")
      .replace(/^DeepSeek request failed \((\d+)\):\s*/i, "DeepSeek $1：")
      .replace(/^Custom API request failed \((\d+)\):\s*/i, "API $1：")
      .slice(0, 90);
  }

  function missingApiConfigText() {
    const config = Core.resolveTranslationConfig(state.settings);
    return `请在扩展选项页填写 ${config.providerLabel} API 配置`;
  }

  function setStatus(text) {
    state.statusText = text || "";
  }
})();
