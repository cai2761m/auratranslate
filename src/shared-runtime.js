// Runtime messaging and translation error classification.
// Browser: register before shared.js. Node: shared.js calls this factory.
(function registerSharedModule(root, register) {
  if (typeof module !== "undefined" && module.exports) module.exports = register;
  else register(root.YTBTShared || (root.YTBTShared = {}));
})(globalThis, function (Shared) {
  "use strict";

  // Categorize a translation error so callers can decide whether retrying is
  // worthwhile. "fatal" must not be retried (bad config, auth, quota);
  // "retryable" should be retried with backoff (transient network/rate-limit/
  // parsing issues); "unknown" is treated as fatal to be safe.
  const TRANSLATION_FATAL_RE =
    /API Key|not configured|base URL|model|401|403|quota|insufficient/i;
  const TRANSLATION_RETRYABLE_RE =
    /429|rate limit|too many requests|timeout|aborted|network|failed to fetch|non-JSON|invalid translation JSON|invalid sentence segmentation JSON|sentence segmentation (?:did not|groups must|group ids must)|JSON at position|Unexpected .*JSON|Expected .*JSON|empty content|did not contain usable translations|truncated|finish_reason|request failed \(5\d\d\)/i;

  function classifyTranslationError(message) {
    const text = String(message || "");
    if (!text) {
      return "unknown";
    }
    if (TRANSLATION_FATAL_RE.test(text)) {
      return "fatal";
    }
    if (TRANSLATION_RETRYABLE_RE.test(text)) {
      return "retryable";
    }
    return "unknown";
  }

  function isRuntimeConnectionError(message) {
    return /Receiving end does not exist|Could not establish connection|扩展后台暂时无法连接/i.test(String(message || ""));
  }

  // Retry only explicit pre-delivery failures. A closed port or a response
  // timeout does not prove that the background has not already called the API.
  function sendRuntimeMessage(runtime, message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const retryDelays = [250, 750, 1500];
      let retryIndex = 0;
      let retryTimer;
      let settled = false;
      const deadline = setTimeout(() => {
        finish(new Error("Translation request timeout: background did not respond."));
      }, Number(timeoutMs) || 130000);

      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(retryTimer);
        if (error) reject(error);
        else resolve(response);
      }

      function failed(error) {
        if (settled) return;
        const detail = error && error.message ? error.message : String(error);
        if (/Extension context invalidated|context.*(?:invalid|unloaded)/i.test(detail)) {
          finish(new Error("扩展已更新或重新加载，请刷新此视频页面后重试。"));
        } else if (isRuntimeConnectionError(detail)) {
          if (retryIndex < retryDelays.length) {
            retryTimer = setTimeout(attempt, retryDelays[retryIndex++]);
          } else {
            finish(new Error("扩展后台暂时无法连接，请稍后拖动进度条重试；若仍失败，请刷新页面或重新启用扩展。"));
          }
        } else {
          finish(new Error(detail));
        }
      }

      function attempt() {
        if (settled) return;
        try {
          runtime.sendMessage(message, (response) => {
            // Read lastError even for a late callback to consume API errors.
            const error = runtime.lastError;
            if (settled) return;
            if (error) failed(error);
            else if (response === undefined) finish(new Error("扩展后台未返回结果，请刷新页面后重试。"));
            else finish(null, response);
          });
        } catch (error) {
          failed(error);
        }
      }

      attempt();
    });
  }

  Object.assign(Shared, { classifyTranslationError, isRuntimeConnectionError, sendRuntimeMessage });
});
