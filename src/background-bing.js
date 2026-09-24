// Bing's public web translator exposes an undocumented no-key endpoint. Its
// short-lived anti-abuse credentials are read from the translator page and kept
// only in worker memory; the service may change or rate-limit this interface.
let bingCredentials = null;
let bingCredentialsExpiresAt = 0;
let bingCredentialsPromise = null;
let bingFreeCooldownUntil = 0;

async function getBingCredentials(deadline) {
  if (bingCredentials && Date.now() < bingCredentialsExpiresAt) return bingCredentials;
  if (bingCredentialsPromise) return bingCredentialsPromise;

  bingCredentialsPromise = (async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("兜底处理时间已用完。");
    let response;
    let html;
    try {
      ({ response, bodyText: html } = await fetchWithTimeout(
        "https://www.bing.com/translator",
        { credentials: "omit", referrerPolicy: "no-referrer" },
        Math.min(10000, remaining),
        false
      ));
    } catch (error) {
      throw new Error(`获取 Bing 会话失败：${error.message}`);
    }
    if (!response.ok) throw new Error(`获取 Bing 会话失败（HTTP ${response.status}）。`);

    const ig = html.match(/["']ig["']\s*:\s*["']([\da-f]{32})["']/i)?.[1];
    const iids = [...html.matchAll(/data-iid=["']([^"']+)["']/gi)];
    const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[\s*([^,\]]+)\s*,\s*["']([^"']+)["']/i);
    const iid = iids.at(-1)?.[1];
    const key = abuse?.[1]?.trim();
    const token = abuse?.[2];
    if (!ig || !iid || !key || !token) {
      throw new Error("Bing 翻译页面未返回可用会话，请稍后重试。");
    }

    bingCredentials = { ig, iid, key, token };
    bingCredentialsExpiresAt = Date.now() + 4 * 60 * 1000;
    return bingCredentials;
  })();

  try {
    return await bingCredentialsPromise;
  } finally {
    bingCredentialsPromise = null;
  }
}

async function translateBingCue(text, request, deadline, hasFormatting = false) {
  if (hasFormatting) restoreGoogleFormatting(text, text);
  const source = bingLanguage(request.sourceLanguage || "auto");
  const target = bingLanguage(request.targetLanguage || "zh-CN");
  const parts = googleParagraphChunks(text, hasFormatting, 1000).map((part) => {
    const [, before, content, after] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { text: content, before, after };
  });

  for (const part of parts) {
    const translation = await withGoogleSlot(async () => {
      if (Date.now() < bingFreeCooldownUntil) {
        throw new Error("免 Key 接口暂不可用，冷却后可手动重试，或切换其他服务。");
      }
      const credentials = await getBingCredentials(deadline);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("兜底处理时间已用完，请手动重试剩余段落。");

      const endpoint = new URL("https://www.bing.com/ttranslatev3");
      endpoint.searchParams.set("isVertical", "1");
      endpoint.searchParams.set("IG", credentials.ig);
      endpoint.searchParams.set("IID", credentials.iid);
      const body = new URLSearchParams({
        fromLang: source,
        to: target,
        text: part.text,
        token: credentials.token,
        key: credentials.key
      });
      const { response, bodyText } = await fetchWithTimeout(endpoint.href, {
        method: "POST",
        credentials: "omit",
        referrer: "https://www.bing.com/translator",
        referrerPolicy: "strict-origin-when-cross-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: body.toString()
      }, Math.min(15000, remaining), false);
      if (!response.ok) {
        if (response.status === 429) bingFreeCooldownUntil = Date.now() + 60000;
        throw new Error(`Bing 免 Key 请求失败（HTTP ${response.status}）${response.status === 429 ? "，已被限流。" : "。"}`);
      }

      let payload;
      try { payload = JSON.parse(bodyText); }
      catch { throw new Error("Bing 返回了无效 JSON。"); }
      const translated = payload?.[0]?.translations?.[0]?.text;
      if (typeof translated !== "string" || !translated.trim()) {
        const statusCode = Number(payload?.[0]?.statusCode);
        if (payload?.[0]?.errorMessage || statusCode) {
          bingCredentialsExpiresAt = 0;
        }
        if (statusCode === 429) bingFreeCooldownUntil = Date.now() + 60000;
        throw new Error("Bing 未返回译文，会话可能已失效或接口已限流。");
      }
      return translated;
    });
    part.text = translation;
  }

  const translated = parts.map((part) => `${part.before}${part.text}${part.after}`).join("");
  return hasFormatting ? restoreGoogleFormatting(text, translated) : translated;
}

function bingLanguage(language) {
  const code = String(language || "auto").trim();
  if (/^auto$/i.test(code)) return "auto-detect";
  if (/^zh-(cn|sg)$/i.test(code)) return "zh-Hans";
  if (/^zh-(tw|hk|mo)$/i.test(code)) return "zh-Hant";
  return code.split("-")[0];
}
