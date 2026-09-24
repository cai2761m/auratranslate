// YouTube and Drive caption format parsers.
// Browser: register before shared.js. Node: shared.js calls this factory.
(function registerSharedModule(root, register) {
  if (typeof module !== "undefined" && module.exports) module.exports = register;
  else register(root.YTBTShared || (root.YTBTShared = {}));
})(globalThis, function (Shared) {
  "use strict";

  function cueTextFromSegments(segments) {
    if (!Array.isArray(segments)) {
      return "";
    }

    return Shared.normalizeSubtitleText(
      segments
        .map((segment) => (segment && typeof segment.utf8 === "string" ? segment.utf8 : ""))
        .join("")
    );
  }

  function parseJson3Captions(json) {
    if (!json || !Array.isArray(json.events)) {
      return [];
    }

    const cues = [];
    for (const event of json.events) {
      const text = cueTextFromSegments(event.segs);
      if (!text) {
        continue;
      }

      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(startMs)) {
        continue;
      }

      cues.push({
        startMs: Math.max(0, startMs),
        endMs: Math.max(startMs + 1, startMs + (Number.isFinite(durationMs) ? durationMs : 1500)),
        sourceText: text
      });
    }

    for (let index = 0; index < cues.length - 1; index += 1) {
      if (cues[index].endMs > cues[index + 1].startMs) {
        cues[index].endMs = Math.max(cues[index].startMs + 1, cues[index + 1].startMs);
      }
    }

    return cues;
  }

  function parseVttTime(value) {
    const match = String(value).trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
    if (!match) {
      return NaN;
    }

    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = Number(match[4]);
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  }

  function parseVttCaptions(text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
    const cues = [];
    let index = 0;

    while (index < lines.length) {
      let line = lines[index].trim();
      if (!line || line === "WEBVTT" || line.startsWith("NOTE")) {
        index += 1;
        continue;
      }

      if (!line.includes("-->") && index + 1 < lines.length && lines[index + 1].includes("-->")) {
        index += 1;
        line = lines[index].trim();
      }

      if (!line.includes("-->")) {
        index += 1;
        continue;
      }

      const [startRaw, endRaw] = line.split("-->");
      const startMs = parseVttTime(startRaw);
      const endMs = parseVttTime(endRaw.trim().split(/\s+/)[0]);
      index += 1;

      const textLines = [];
      while (index < lines.length && lines[index].trim()) {
        textLines.push(lines[index]);
        index += 1;
      }

      const cueText = Shared.normalizeSubtitleText(textLines.join(" "));
      if (cueText && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        cues.push({ startMs, endMs, sourceText: cueText });
      }
    }

    return cues;
  }

  function readXmlAttribute(attrs, name) {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i");
    const match = String(attrs || "").match(pattern);
    return match ? match[1] : "";
  }

  function secondsToMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number * 1000 : NaN;
  }

  function millisToMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function timeExpressionToMs(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return NaN;
    }
    if (/^\d+(?:\.\d+)?ms$/i.test(raw)) {
      return Number(raw.replace(/ms$/i, ""));
    }
    if (/^\d+(?:\.\d+)?s$/i.test(raw)) {
      return Number(raw.replace(/s$/i, "")) * 1000;
    }
    if (raw.includes(":")) {
      return parseVttTime(raw);
    }
    return secondsToMs(raw);
  }

  function parseXmlCaptions(text) {
    const input = String(text || "");
    const cues = [];

    const transcriptTextRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = transcriptTextRe.exec(input))) {
      const attrs = match[1];
      const startMs = secondsToMs(readXmlAttribute(attrs, "start"));
      const durationMs = secondsToMs(readXmlAttribute(attrs, "dur"));
      const sourceText = Shared.normalizeSubtitleText(match[2]);
      if (sourceText && Number.isFinite(startMs)) {
        cues.push({
          startMs,
          endMs: Math.max(startMs + 1, startMs + (Number.isFinite(durationMs) ? durationMs : 1500)),
          sourceText
        });
      }
    }

    if (!cues.length) {
      const paragraphRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
      while ((match = paragraphRe.exec(input))) {
      const attrs = match[1];
      const tAttr = readXmlAttribute(attrs, "t");
      const dAttr = readXmlAttribute(attrs, "d");
      const startMs = tAttr ? millisToMs(tAttr) : timeExpressionToMs(readXmlAttribute(attrs, "begin"));
      const durationMs = dAttr ? millisToMs(dAttr) : timeExpressionToMs(readXmlAttribute(attrs, "dur"));
      const explicitEndMs = timeExpressionToMs(readXmlAttribute(attrs, "end"));
      const sourceText = Shared.normalizeSubtitleText(match[2]);
      if (sourceText && Number.isFinite(startMs)) {
        cues.push({
          startMs,
          endMs: Math.max(
            startMs + 1,
            Number.isFinite(explicitEndMs)
              ? explicitEndMs
              : startMs + (Number.isFinite(durationMs) ? durationMs : 1500)
          ),
          sourceText
        });
      }
      }
    }

    return cues.sort((left, right) => left.startMs - right.startMs);
  }

  function runsToText(runs) {
    if (!Array.isArray(runs)) {
      return "";
    }
    return Shared.normalizeSubtitleText(runs.map((run) => (run && run.text) || "").join(""));
  }

  function collectTranscriptSegments(value, segments, depth) {
    if (!value || depth > 24) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectTranscriptSegments(item, segments, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (value.transcriptSegmentRenderer) {
      const segment = value.transcriptSegmentRenderer;
      const startMs = Number(segment.startMs);
      const endMs = Number(segment.endMs);
      const sourceText = runsToText(segment.snippet && segment.snippet.runs);
      if (sourceText && Number.isFinite(startMs)) {
        segments.push({
          startMs,
          endMs: Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + 1500,
          sourceText
        });
      }
    }

    for (const item of Object.values(value)) {
      collectTranscriptSegments(item, segments, depth + 1);
    }
  }

  function parseYouTubeTranscriptResponse(json) {
    const cues = [];
    collectTranscriptSegments(json, cues, 0);
    return cues.sort((left, right) => left.startMs - right.startMs);
  }

  function transcriptPanelTimestampToMs(value) {
    const raw = String(value == null ? "" : value).trim();
    const parts = raw.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
      return NaN;
    }

    const hasValidShape = parts.length === 2
      ? /^\d+:\d{2}$/.test(raw)
      : /^\d+:\d{2}:\d{2}$/.test(raw);
    if (!hasValidShape) {
      return NaN;
    }

    const numbers = parts.map(Number);
    const seconds = numbers[numbers.length - 1];
    const minutes = numbers[numbers.length - 2];
    if (seconds >= 60 || (parts.length === 3 && minutes >= 60)) {
      return NaN;
    }

    const hours = parts.length === 3 ? numbers[0] : 0;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
  }

  function collectTranscriptPanelSegments(value, segments, parentStartMs, depth) {
    if (!value || depth > 32) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectTranscriptPanelSegments(item, segments, parentStartMs, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (value.transcriptSegmentViewModel) {
      const segment = value.transcriptSegmentViewModel;
      const sourceText = Shared.normalizeSubtitleText(segment && segment.simpleText);
      const timestampMs = transcriptPanelTimestampToMs(segment && segment.timestamp);
      const startMs = Number.isFinite(timestampMs) ? timestampMs : parentStartMs;
      if (sourceText && Number.isFinite(startMs) && startMs >= 0) {
        segments.push({ startMs, sourceText });
      }
    }

    for (const [key, item] of Object.entries(value)) {
      if (key === "timelineItemViewModel" && item && typeof item === "object") {
        const rawStartTimeSeconds = item.startTimeSeconds;
        const startTimeSeconds = rawStartTimeSeconds == null || rawStartTimeSeconds === ""
          ? NaN
          : Number(rawStartTimeSeconds);
        const timelineStartMs = Number.isFinite(startTimeSeconds) && startTimeSeconds >= 0
          ? startTimeSeconds * 1000
          : parentStartMs;
        collectTranscriptPanelSegments(item, segments, timelineStartMs, depth + 1);
      } else {
        collectTranscriptPanelSegments(item, segments, parentStartMs, depth + 1);
      }
    }
  }

  function parseYouTubeTranscriptPanelResponse(json) {
    const segments = [];
    collectTranscriptPanelSegments(json, segments, NaN, 0);
    segments.sort((left, right) => left.startMs - right.startMs);

    const unique = [];
    const seen = new Set();
    for (const segment of segments) {
      const key = `${segment.startMs}:${segment.sourceText}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(segment);
    }

    return unique.map((segment, index) => {
      const next = unique[index + 1];
      const endMs = next ? next.startMs : segment.startMs + 5000;
      return {
        startMs: segment.startMs,
        endMs: Math.max(segment.startMs + 1, endMs),
        sourceText: segment.sourceText
      };
    });
  }

  function parseGoogleDriveTranscriptItems(items, finalEndMs) {
    const normalized = [];
    const seen = new Set();

    for (const item of Array.isArray(items) ? items : []) {
      const startMs = Number(item && item.startMs);
      const sourceText = Shared.normalizeSubtitleText(item && item.sourceText);
      if (!Number.isFinite(startMs) || startMs < 0 || !sourceText) {
        continue;
      }

      const key = `${startMs}:${sourceText}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({ startMs, sourceText });
    }

    normalized.sort((left, right) => left.startMs - right.startMs);
    const explicitFinalEndMs = Number(finalEndMs);

    return normalized.map((item, index) => {
      const next = normalized[index + 1];
      const inferredEndMs = next
        ? next.startMs
        : Number.isFinite(explicitFinalEndMs) && explicitFinalEndMs > item.startMs
          ? explicitFinalEndMs
          : item.startMs + 5000;

      return {
        startMs: item.startMs,
        endMs: Math.max(item.startMs + 1, inferredEndMs),
        sourceText: item.sourceText
      };
    });
  }

  function findYouTubeTranscriptParams(value, depth) {
    if (!value || depth > 24) {
      return "";
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const params = findYouTubeTranscriptParams(item, depth + 1);
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
      const params = findYouTubeTranscriptParams(item, depth + 1);
      if (params) {
        return params;
      }
    }

    return "";
  }

  function findCueAtTime(cues, timeMs) {
    if (!Array.isArray(cues) || !Number.isFinite(timeMs)) {
      return null;
    }

    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const cue = cues[middle];
      if (timeMs < cue.startMs) {
        high = middle - 1;
      } else if (timeMs >= cue.endMs) {
        low = middle + 1;
      } else {
        return cue;
      }
    }

    return null;
  }

  Object.assign(Shared, {
    parseJson3Captions,
    parseVttTime,
    parseVttCaptions,
    parseXmlCaptions,
    parseYouTubeTranscriptResponse,
    parseYouTubeTranscriptPanelResponse,
    parseGoogleDriveTranscriptItems,
    findYouTubeTranscriptParams,
    findCueAtTime
  });
});
