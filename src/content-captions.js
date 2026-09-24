/*
 * AuraTranslate content script — caption track discovery, fetching, and caching
 *
 * The src/content-*.js files are separate classic scripts that the browser evaluates
 * in one shared isolated-world scope, so top-level declarations here are visible to the
 * other content-*.js files. manifest.json fixes the load order:
 *   content-core -> content-captions -> content-translation -> content-player
 *   -> content-overlay -> content-main
 * Keep top-level names unique across these files, and declare shared bindings with
 * `var` (never `const`/`let`) so a re-injection cannot fail with a redeclaration error.
 */
"use strict";

// --- Caption track selection and prepared-cue cache ---
function resetVideoState(videoId, track, trackFingerprint, transcript) {
  state.videoId = videoId || "";
  state.track = track;
  state.transcript = transcript || null;
  state.trackFingerprint = trackFingerprint || "";
  state.translationTrackFingerprint = trackFingerprint || "";
  state.captionLoadKey = "";
  state.captionLoadPromise = null;
  state.cues = [];
  state.preparationPromise = null;
  state.preparationBlocked = false;
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
      "modern-panel-v1",
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
    "modern-panel-v1",
    videoId || "",
    sourceLang,
    transcript && transcript.apiKey ? "api" : ""
  ].join("|"));
}

function makeCaptionLoadKey(trackFingerprint, track, transcript) {
  const capturedText = String(track && track.capturedText || "");
  return Core.fingerprintText([
    trackFingerprint || "",
    String(track && track.baseUrl || ""),
    capturedText ? Core.fingerprintText(capturedText) : "",
    String(transcript && transcript.params || ""),
    String(transcript && transcript.clientVersion || "")
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
    if (await restorePreparedCaptionCues(videoId, trackFingerprint, token)) {
      return;
    }
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

function preparedCaptionCacheKey(videoId, trackFingerprint) {
  const settings = state.settings;
  const config = Core.resolveTranslationConfig(settings);
  const track = state.track;
  // Track names and signed caption URLs change across page loads. Keep the
  // saved cue layout independent of those display/transport details.
  const trackIdentity = IS_DRIVE_PLAYER
    ? ["drive"]
    : ["youtube", track && track.languageCode || "", track && track.kind || "", track && track.vssId || ""];
  const parts = [
    videoId, ...trackIdentity, settings.sourceLanguage,
    Core.MERGE_VERSION, settings.cacheVersion || "1",
    settings.llmSentenceSegmentationEnabled ? "llm" : "local"
  ];
  if (settings.llmSentenceSegmentationEnabled) {
    parts.push(config.provider, config.apiStyle === "gemini" ? config.generateContentUrl : config.chatCompletionsUrl,
      config.model, Core.SENTENCE_SEGMENTATION_VERSION);
  }
  return PREPARED_CAPTION_CACHE_PREFIX + Core.fingerprintText(JSON.stringify(parts));
}

function isCurrentCaptionLoad(videoId, trackFingerprint, token) {
  return token === state.loadingToken && videoId === state.videoId && trackFingerprint === state.trackFingerprint;
}

function validPreparedCaptionCache(value, videoId) {
  if (!value || ![1, 2].includes(value.version) || value.videoId !== videoId ||
      !value.trackFingerprint || !Array.isArray(value.cues) || !value.cues.length) return false;
  const ids = new Set();
  return value.cues.every((cue, index) => {
    if (!cue || cue.id == null || !String(cue.id) || ids.has(String(cue.id)) ||
        !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0 ||
        cue.endMs <= cue.startMs || typeof cue.sourceText !== "string" || !Core.normalizeSubtitleText(cue.sourceText) ||
        (index > 0 && cue.startMs < value.cues[index - 1].startMs) ||
        (cue.pendingWindow != null && (value.version !== 2 || !/^w:\d+$/.test(cue.pendingWindow)))) return false;
    ids.add(String(cue.id));
    return true;
  });
}

async function restorePreparedCaptionCues(videoId, trackFingerprint, token) {
  const key = preparedCaptionCacheKey(videoId, trackFingerprint);
  const stored = await storageGet({ [key]: null });
  if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return true;
  const cached = stored[key];
  if (!validPreparedCaptionCache(cached, videoId)) return false;
  // Reuse the original cache namespace even if YouTube localized the track's
  // name since the saved translation. The cue source and ids are unchanged.
  state.translationTrackFingerprint = cached.trackFingerprint;
  await activateCaptionCues(cached.cues, videoId, trackFingerprint, token);
  return true;
}

async function persistPreparedCaptionCues(cues, videoId, trackFingerprint, token) {
  const key = preparedCaptionCacheKey(videoId, trackFingerprint);
  const value = {
    version: 2, videoId, trackFingerprint: state.translationTrackFingerprint || trackFingerprint, updatedAt: Date.now(),
    cues: cues.map((cue) => ({
      id: String(cue.id), startMs: cue.startMs, endMs: cue.endMs,
      sourceText: cue.sourceText, displaySourceText: cue.displaySourceText || "",
      ...(cue.pendingWindow ? { pendingWindow: cue.pendingWindow } : {})
    }))
  };
  const all = await storageGet(null);
  if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
  const olderKeys = Object.keys(all)
    .filter((entry) => entry.startsWith(PREPARED_CAPTION_CACHE_PREFIX) && entry !== key)
    .sort((left, right) => (Number(all[right] && all[right].updatedAt) || 0) - (Number(all[left] && all[left].updatedAt) || 0));
  const staleKeys = olderKeys.splice(MAX_PREPARED_CAPTION_CACHE_ENTRIES - 1);
  if (staleKeys.length) {
    await storageRemove(staleKeys);
  }
  // Long videos can reach the byte quota before the entry-count limit.
  // Free older timelines and retry the same data, without paying for it again.
  while (isCurrentCaptionLoad(videoId, trackFingerprint, token)) {
    try {
      await storageSet({ [key]: value });
      return;
    } catch (error) {
      if (!/quota|QUOTA_BYTES/i.test(error.message) || !olderKeys.length) throw error;
      await storageRemove([olderKeys.pop()]);
    }
  }
}

async function hydrateCaptionTranslations(cues, videoId, trackFingerprint, token) {
  // Read every existing translation before publishing cues to the scheduler.
  // This read-only request must never start a paid API call.
  const response = await sendMessage({
    type: "TRANSLATE_BATCH", cacheOnly: true, videoId,
    trackFingerprint: state.translationTrackFingerprint || trackFingerprint,
    cues: cues.filter((cue) => !cue.pendingWindow).map((cue) => ({ id: cue.id, sourceText: cue.sourceText }))
  });
  if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
  if (!response || response.ok === false) {
    const error = response && response.errors && response.errors[0];
    throw new Error(`读取本地翻译缓存失败，已暂停翻译：${error && error.message || "后台无响应"}`);
  }
  const prepared = cues.map((cue) => Object.assign({}, cue, {
    status: cue.pendingWindow ? "unprepared" : "pending", translatedText: ""
  }));
  const items = response.items || [];
  const cachedIds = new Set(items.filter((item) => item && item.translatedText).map((item) => String(item.id)));
  applyTranslations({ cues: prepared.filter((cue) => cachedIds.has(String(cue.id))) }, items);
  return prepared;
}

async function activateCaptionCues(cues, videoId, trackFingerprint, token, fallbackMessage) {
  const prepared = await hydrateCaptionTranslations(cues, videoId, trackFingerprint, token);
  if (!prepared || !isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
  state.cues = prepared;
  if (fallbackMessage) {
    setStatus(`LLM 智能断句失败，已回退本地断句：${fallbackMessage}`);
  }
  if (prepared.every((cue) => cue.status === "translated")) {
    setStatus(`已从本地缓存恢复 ${prepared.length}/${prepared.length} 条字幕。`);
    return;
  }
  scheduleTranslations(getCurrentTimeMs(), true);
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

  const preparedCues = state.settings.llmSentenceSegmentationEnabled
    ? makeIncrementalCaptionCues(Core.splitCaptionCuesAtSentenceBoundaries(merged)) : merged;
  // Persist the raw remainder too: refresh can resume without fetching the
  // track again, while completed windows retain their exact cue identities.
  await persistPreparedCaptionCues(preparedCues, videoId, trackFingerprint, token);
  if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
  await activateCaptionCues(preparedCues, videoId, trackFingerprint, token);
}

function makeIncrementalCaptionCues(cues) {
  let windowIndex = 0;
  let startIndex = 0;
  return cues.map((cue, index) => {
    const result = { ...cue, id: `raw:${cue.id}`, pendingWindow: `w:${windowIndex}` };
    const count = index - startIndex + 1;
    const duration = cue.endMs - cues[startIndex].startMs;
    const next = cues[index + 1];
    const naturalBoundary = /[.!?。！？]["')\]]*$/.test(cue.sourceText) ||
      (next && next.startMs - cue.endMs > 1500);
    // Prefer sentence endings; cap pathological unpunctuated tracks so the
    // first provider request stays small. Boundaries never depend on seeks.
    if (((duration >= 20000 || count >= 8) && naturalBoundary) || duration >= 40000 || count >= 16) {
      windowIndex += 1;
      startIndex = index + 1;
    }
    return result;
  });
}

function shouldPrepareWindow(cues, anchorMs) {
  return cues.some((cue) => isCueInTranslationWindow(cue, anchorMs));
}

function ensureCaptionPreparation() {
  if (state.preparationPromise || state.preparationBlocked || !state.settings.subtitleEnabled || !hasApiKey()) {
    return state.preparationPromise;
  }
  const { videoId, trackFingerprint, loadingToken: token } = state;
  const work = (async () => {
    while (isCurrentCaptionLoad(videoId, trackFingerprint, token) && state.settings.subtitleEnabled && !isInApiBackoff()) {
      const windows = new Map();
      for (const cue of state.cues) {
        if (!cue.pendingWindow) continue;
        if (!windows.has(cue.pendingWindow)) windows.set(cue.pendingWindow, []);
        windows.get(cue.pendingWindow).push(cue);
      }
      const anchorMs = getCurrentTimeMs();
      const eligible = [...windows.values()].filter((cues) => shouldPrepareWindow(cues, anchorMs));
      eligible.sort((a, b) => Math.min(...a.map((cue) => priorityScore(cue, anchorMs))) -
        Math.min(...b.map((cue) => priorityScore(cue, anchorMs))));
      const input = eligible[0];
      if (!input) break;
      const windowId = input[0].pendingWindow;
      let prepared;
      try {
        const response = await sendMessage({
          type: "SEGMENT_SUBTITLES", videoId,
          trackFingerprint: state.translationTrackFingerprint || trackFingerprint,
          cues: input.map(({ id, startMs, endMs, sourceText }) => ({ id, startMs, endMs, sourceText }))
        }, SEGMENTATION_MESSAGE_TIMEOUT_MS);
        if (!response || response.ok === false) {
          throw new Error(response && response.errors && response.errors[0] && response.errors[0].message || "LLM 智能断句失败");
        }
        prepared = Core.applySentenceSegmentationGroups(input, response.groups || []);
      } catch (error) {
        if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
        // Storage errors must never turn into new paid translation work.
        if (/cache|storage|缓存|保存|quota|QUOTA_BYTES/i.test(error.message)) throw error;
        if (Core.classifyTranslationError(error.message) === "fatal") throw error;
        const backoffMs = apiBackoffMsForError(error.message);
        if (backoffMs) applyApiBackoff(error.message, backoffMs);
        // A failed window falls back once, without replaying an ambiguous
        // segmentation request. Other windows remain eligible for later work.
        prepared = input.map(({ pendingWindow, ...cue }) => cue);
        setStatus(`当前片段智能断句失败，使用本地断句：${simplifyTranslationError(error.message)}`);
      }
      if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
      prepared = prepared.map((cue, index) => ({ ...cue, id: `${windowId}:${index}` }));
      const nextCues = state.cues.filter((cue) => cue.pendingWindow !== windowId).concat(prepared)
        .sort((a, b) => a.startMs - b.startMs);
      await persistPreparedCaptionCues(nextCues, videoId, trackFingerprint, token);
      const hydrated = await hydrateCaptionTranslations(prepared, videoId, trackFingerprint, token);
      if (!hydrated || !isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
      // Keep existing cue objects: translation responses may have arrived
      // while the next window was being segmented or saved.
      state.cues = state.cues.filter((cue) => cue.pendingWindow !== windowId).concat(hydrated)
        .sort((a, b) => a.startMs - b.startMs);
      scheduleTranslations(getCurrentTimeMs(), true);
    }
  })().catch((error) => {
    if (!isCurrentCaptionLoad(videoId, trackFingerprint, token)) return;
    state.preparationBlocked = true;
    state.queue = [];
    setStatus(`字幕准备失败，已暂停新请求：${error.message || error}`);
  }).finally(() => {
    if (state.preparationPromise === work) state.preparationPromise = null;
  });
  state.preparationPromise = work;
  return work;
}


// --- Caption and transcript transport ---
async function fetchCaptionData(track, videoId, transcript) {
  const errors = [];
  let resolvedTranscript = transcript;

  if (videoId) {
    try {
      setStatus("正在读取 YouTube 转写面板...");
      return await fetchTranscriptPanelTrack(videoId, resolvedTranscript);
    } catch (error) {
      errors.push(`transcript panel: ${error.message || String(error)}`);
    }
  }

  if (track && track.capturedText) {
    try {
      return parseCapturedCaptionText(track.capturedText);
    } catch (error) {
      errors.push(`captured timedtext: ${error.message || String(error)}`);
    }
  }

  if (track && track.baseUrl) {
    try {
      return await fetchCaptionTrack(track, videoId);
    } catch (error) {
      errors.push(`timedtext: ${error.message || String(error)}`);
      if (!isCaptionRateLimitError(error)) {
        try {
          setStatus("字幕接口不可用，正在请求播放器读取原生字幕...");
          const capturedTrack = await requestNativeCaptionData(videoId, track);
          if (capturedTrack && capturedTrack.capturedText) {
            return parseCapturedCaptionText(capturedTrack.capturedText);
          }
        } catch (captureError) {
          errors.push(`native player: ${captureError.message || String(captureError)}`);
        }
      }
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
      label: "original",
      format: null,
      parse: parseCapturedCaptionText
    }
  ];

  const errors = [];
  const baseUrls = buildCaptionBaseUrls(track, videoId);

  for (let urlIndex = 0; urlIndex < baseUrls.length; urlIndex += 1) {
    const baseUrl = baseUrls[urlIndex];
    const sourceLabel = urlIndex === 0 ? "player" : `legacy${urlIndex}`;
    let terminalError = null;

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
        if (error && (error.captionHttpStatus || error.captionEmpty)) {
          terminalError = error;
          break;
        }
      }
    }
    if (terminalError) {
      throw terminalError;
    }
  }

  throw new Error(`No usable captions found (${errors.join("; ")}).`);
}

function parseCapturedCaptionText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("empty response");
  }
  let cues;
  if (trimmed.startsWith("{")) {
    cues = Core.parseJson3Captions(parseCaptionJson(trimmed));
  } else if (trimmed.startsWith("WEBVTT")) {
    cues = Core.parseVttCaptions(trimmed);
  } else {
    cues = Core.parseXmlCaptions(trimmed);
  }
  if (!cues.length) {
    throw new Error("response did not contain caption cues");
  }
  return cues;
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

  if (!urls.length && videoId) {
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
    const error = new Error(`Timedtext request failed (${response.status})`);
    error.captionHttpStatus = response.status;
    throw error;
  }
  if (!text.trim()) {
    const error = new Error(`${label || format || "caption"} returned empty response`);
    error.captionEmpty = true;
    throw error;
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

async function fetchTranscriptPanelTrack(videoId, transcript) {
  const params = transcriptPanelParams(videoId);
  if (!params) {
    throw new Error("invalid video id");
  }

  const detectedVersion = String(
    transcript && (
      transcript.clientVersion ||
      (transcript.context && transcript.context.client && transcript.context.client.clientVersion)
    ) || ""
  );
  const versions = Array.from(new Set([
    detectedVersion,
    TRANSCRIPT_CLIENT_VERSION_FALLBACK
  ].filter(Boolean)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPT_PANEL_TIMEOUT_MS);
  const errors = [];

  try {
    for (const clientVersion of versions) {
      try {
        const cues = await requestTranscriptPanel(params, clientVersion, transcript, controller.signal);
        if (cues.length) {
          return cues;
        }
        errors.push(`${clientVersion}: no transcript segments`);
      } catch (error) {
        errors.push(`${clientVersion}: ${error.message || String(error)}`);
        if (error && error.transcriptPanelStatus === 429) {
          break;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  throw new Error(errors.join("; ") || "transcript panel is unavailable");
}

async function requestTranscriptPanel(params, clientVersion, transcript, signal) {
  const url = new URL("/youtubei/v1/get_panel", window.location.origin);
  url.searchParams.set("prettyPrint", "false");
  const contextClient = transcript && transcript.context && transcript.context.client || {};
  let response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion,
            hl: String(contextClient.hl || "en"),
            gl: String(contextClient.gl || "US")
          }
        },
        panelId: TRANSCRIPT_PANEL_ID,
        params
      }),
      signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("request timed out");
    }
    throw error;
  }

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`request failed (${response.status})`);
    error.transcriptPanelStatus = response.status;
    throw error;
  }
  if (text.length > TRANSCRIPT_PANEL_MAX_BODY_LENGTH) {
    throw new Error("response was too large");
  }

  const json = parseCaptionJson(text);
  const cues = Core.parseYouTubeTranscriptPanelResponse(json);
  if (!cues.length) {
    throw new Error("response did not contain transcript segments");
  }
  return cues;
}

function transcriptPanelParams(videoId) {
  const id = String(videoId || "");
  if (!/^[\w-]{1,64}$/.test(id)) {
    return "";
  }

  const bytes = [0xaa, 0x09, id.length + 4, 0x0a, id.length];
  for (let index = 0; index < id.length; index += 1) {
    bytes.push(id.charCodeAt(index) & 0xff);
  }
  bytes.push(0x18, 0x01);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  try {
    return btoa(binary);
  } catch (error) {
    return "";
  }
}

function requestNativeCaptionData(videoId, track) {
  if (!videoId || !track) {
    return Promise.reject(new Error("caption track is unavailable"));
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      videoId,
      track,
      resolve,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      state.nativeCaptionWaiters.delete(waiter);
      reject(new Error("player caption capture timed out"));
    }, NATIVE_CAPTION_CAPTURE_TIMEOUT_MS);
    state.nativeCaptionWaiters.add(waiter);
    window.postMessage(
      {
        channel: CHANNEL,
        type: "REQUEST_NATIVE_CAPTIONS",
        videoId,
        track: {
          baseUrl: String(track.baseUrl || ""),
          languageCode: String(track.languageCode || ""),
          kind: String(track.kind || ""),
          vssId: String(track.vssId || "")
        }
      },
      window.location.origin
    );
  });
}

function isCaptionRateLimitError(error) {
  return Boolean(error && (
    error.captionHttpStatus === 429 ||
    /\b429\b/.test(String(error.message || error))
  ));
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
  if (/\b429\b/.test(message)) {
    return "YouTube 暂时限制了字幕请求（HTTP 429）。扩展已停止连续重试，请等待几分钟后刷新页面。";
  }
  if (message.includes("returned empty response")) {
    return "YouTube 字幕接口返回空内容，播放器校验令牌可能尚未就绪。请稍后刷新，或先打开一次原生 CC。";
  }
  if (message.includes("FAILED_PRECONDITION") || message.includes("Precondition check failed")) {
    return "YouTube 旧版转写接口已拒绝请求，且现代转写面板暂时不可用。请稍后刷新页面。";
  }
  if (message.includes("No usable captions found")) {
    return `YouTube 没有返回可用字幕：${Core.normalizeSubtitleText(message).slice(0, 180)}`;
  }
  return message;
}
