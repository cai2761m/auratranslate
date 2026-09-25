// Google translation plus shared paragraph chunking, formatting checks, and request limits.
// Classic scripts share the dedicated background scope; background.js loads them
// synchronously in Chrome, and manifest.json supplies the same order in Firefox.
function googleParagraphChunks(text, hasFormatting, maxLength = 4000) {
  const tokens = hasFormatting ? text.split(/(\[\[\/?YTBT_[A-Z]+_\d+\]\])/g) : [text];
  const units = [];
  let depth = 0;
  let formatted = "";
  for (const token of tokens) {
    if (hasFormatting && /^\[\[YTBT_/.test(token)) depth++;
    if (depth) formatted += token;
    else units.push(...Array.from(token));
    if (hasFormatting && /^\[\[\/YTBT_/.test(token)) {
      depth--;
      if (!depth) { units.push(formatted); formatted = ""; }
    }
  }
  if (depth || formatted) throw new Error("网页格式标记不完整，无法翻译。");
  const chunks = [];
  for (let start = 0; start < units.length;) {
    let end = start;
    let count = 0;
    let sentenceEnd = start;
    let wordEnd = start;
    while (end < units.length && count + Array.from(units[end]).length <= maxLength) {
      count += Array.from(units[end]).length;
      if (/^\s$/.test(units[end])) {
        wordEnd = end + 1;
        if (/[.!?。！？]["'”’)]?$/.test(units[end - 1] || "")) sentenceEnd = end + 1;
      }
      end++;
    }
    if (end === start) throw new Error("单个格式片段过长，请改用 AI 翻译。");
    if (end < units.length) end = sentenceEnd > start ? sentenceEnd : wordEnd > start ? wordEnd : end;
    chunks.push(units.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

function restoreGoogleFormatting(source, translated) {
  const invalid = () => new Error("Google 未完整保留网页格式标记，请改用 AI 翻译。");
  function read(text) {
    const formats = new Map();
    const stack = [];
    const marker = /\[\[(\/?)YTBT_([A-Z]+_\d+)\]\]/g;
    for (const match of text.matchAll(marker)) {
      const [, closing, key] = match;
      if (closing) {
        if (stack.pop() !== key) throw invalid();
        const entry = formats.get(key);
        entry.inner = text.slice(entry.start, match.index);
      } else {
        if (formats.has(key)) throw invalid();
        formats.set(key, { parent: stack.at(-1), start: match.index + match[0].length });
        stack.push(key);
      }
    }
    if (stack.length || /\[\[\/?YTBT_/i.test(text.replace(marker, ""))) throw invalid();
    return formats;
  }
  const expected = read(source);
  const actual = read(translated);
  if (expected.size !== actual.size) throw invalid();
  for (const [key, entry] of expected) {
    if (!actual.has(key) || actual.get(key).parent !== entry.parent) throw invalid();
  }
  // Identifiers and line breaks come from the page even if Google translated
  // their contents. Everything else stays in the provider's translated order.
  return translated.replace(/\[\[YTBT_((?:CODE|KBD|SAMP|BR)_\d+)\]\][\s\S]*?\[\[\/YTBT_\1\]\]/g,
    (_, key) => `[[YTBT_${key}]]${expected.get(key).inner}[[/YTBT_${key}]]`);
}

let googleActiveRequests = 0;
const googleRequestWaiters = [];
let googleFreeCooldownUntil = 0;

async function withGoogleSlot(work) {
  if (googleActiveRequests >= 2) await new Promise((resolve) => googleRequestWaiters.push(resolve));
  else googleActiveRequests += 1;
  try { return await work(); }
  finally {
    const next = googleRequestWaiters.shift();
    if (next) next();
    else googleActiveRequests -= 1;
  }
}

async function translateGoogleCue(text, request, settings, deadline, hasFormatting = false) {
  if (settings.immersiveFallbackProvider === "bing-free") {
    return translateBingCue(text, request, deadline, hasFormatting);
  }
  if (hasFormatting) restoreGoogleFormatting(text, text);
  const parts = googleParagraphChunks(text, hasFormatting).map((part) => {
    const [, before, content, after] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { text: content, before, after };
  });
  for (const part of parts) {
    const batch = [part];
    const translations = await withGoogleSlot(async () => {
      if (Date.now() < googleFreeCooldownUntil) throw new Error("免 Key 接口暂不可用，冷却 60 秒后可手动重试。");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("兜底处理时间已用完，请手动重试剩余段落。");
      const source = request.sourceLanguage || "auto";
      const target = request.targetLanguage || "zh-CN";
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(batch[0].text)}`;
      const options = { credentials: "omit", referrerPolicy: "no-referrer" };
      try {
        const { response, bodyText } = await fetchWithTimeout(url, options, Math.min(15000, remaining), false);
        if (!response.ok) throw new Error(`Google 免 Key 请求失败 (${response.status})。${response.status === 429 ? "已被限流。" : "请检查网络连接。"}`);
        let body;
        try { body = JSON.parse(bodyText); }
        catch { throw new Error("Google 返回了无效 JSON。"); }
        const values = [Array.isArray(body?.[0]) ? body[0].map((entry) => typeof entry?.[0] === "string" ? entry[0] : "").join("") : ""];
        if (!Array.isArray(values) || values.length !== batch.length || values.some((value) => typeof value !== "string" || !value.trim())) {
          throw new Error("Google 返回了空译文或不完整结果。");
        }
        return values;
      } catch (error) {
        googleFreeCooldownUntil = Date.now() + 60000;
        throw error;
      }
    });
    batch.forEach((part, index) => { part.text = translations[index]; });
  }
  const translated = parts.map((part) => `${part.before}${part.text}${part.after}`).join("");
  return hasFormatting ? restoreGoogleFormatting(text, translated) : translated;
}
