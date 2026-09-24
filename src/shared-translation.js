// Provider JSON response parsing and recovery.
// Browser: register before shared.js. Node: shared.js calls this factory.
(function registerSharedModule(root, register) {
  if (typeof module !== "undefined" && module.exports) module.exports = register;
  else register(root.YTBTShared || (root.YTBTShared = {}));
})(globalThis, function (Shared) {
  "use strict";

  function parseLooseJsonContent(content) {
    if (typeof content !== "string") {
      return content;
    }

    const raw = content.trim();
    try {
      return JSON.parse(raw);
    } catch (error) {
      // Some providers still wrap JSON in markdown fences when JSON mode is
      // disabled or unsupported.
    }

    const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }

    const firstObject = raw.indexOf("{");
    const lastObject = raw.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      return JSON.parse(raw.slice(firstObject, lastObject + 1));
    }

    const firstArray = raw.indexOf("[");
    const lastArray = raw.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) {
      return JSON.parse(raw.slice(firstArray, lastArray + 1));
    }

    return JSON.parse(raw);
  }

  function unescapeJsonishString(value) {
    return String(value || "").replace(/\\(["\\/bfnrt])/g, (match, escaped) => {
      if (escaped === "b") {
        return "\b";
      }
      if (escaped === "f") {
        return "\f";
      }
      if (escaped === "n") {
        return "\n";
      }
      if (escaped === "r") {
        return "\r";
      }
      if (escaped === "t") {
        return "\t";
      }
      return escaped;
    });
  }

  function extractJsonishStringProperty(fragment, key) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"`, "i");
    const match = pattern.exec(fragment);
    if (!match) {
      return "";
    }

    const start = match.index + match[0].length;
    for (let index = start; index < fragment.length; index += 1) {
      if (fragment[index] !== '"' || fragment[index - 1] === "\\") {
        continue;
      }
      const rest = fragment.slice(index + 1).trimStart();
      if (!rest || rest[0] === "}" || rest[0] === "]" || rest[0] === ",") {
        return unescapeJsonishString(fragment.slice(start, index));
      }
    }

    return unescapeJsonishString(fragment.slice(start));
  }

  function parseJsonishTranslationItems(content) {
    const raw = String(content || "");
    const items = [];
    const itemRe = /\{[\s\S]*?"id"\s*:\s*"?([^",}\]\s]+)"?[\s\S]*?\}/g;
    let match;
    while ((match = itemRe.exec(raw))) {
      const fragment = match[0];
      const id = String(match[1] || "").trim();
      const translatedText = Shared.normalizeSubtitleText(
        extractJsonishStringProperty(fragment, "translatedText") ||
          extractJsonishStringProperty(fragment, "translation") ||
          extractJsonishStringProperty(fragment, "text") ||
          extractJsonishStringProperty(fragment, "zh")
      );
      const displaySourceText = Shared.formatDisplaySourceText(
        extractJsonishStringProperty(fragment, "displaySourceText") ||
          extractJsonishStringProperty(fragment, "punctuatedSourceText") ||
          extractJsonishStringProperty(fragment, "sourceDisplayText")
      );
      if (id && translatedText) {
        const item = { id, translatedText };
        if (displaySourceText) {
          item.displaySourceText = displaySourceText;
        }
        items.push(item);
      }
    }
    return items;
  }

  function parseDeepSeekTranslationContent(content) {
    let parsed;
    try {
      parsed = parseLooseJsonContent(content);
    } catch (error) {
      const recovered = parseJsonishTranslationItems(content);
      if (recovered.length) {
        return recovered;
      }
      throw new Error(`Invalid translation JSON: ${error && error.message ? error.message : String(error)}`);
    }
    const items = [];

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const id = item && item.id != null ? String(item.id) : "";
        const translatedText = Shared.normalizeSubtitleText(
          item && (item.translatedText || item.translation || item.text || item.zh)
        );
        const displaySourceText = Shared.formatDisplaySourceText(
          item && (item.displaySourceText || item.punctuatedSourceText || item.sourceDisplayText)
        );
        if (id && translatedText) {
          const result = { id, translatedText };
          if (displaySourceText) {
            result.displaySourceText = displaySourceText;
          }
          items.push(result);
        }
      }
      return items;
    }

    if (!parsed || typeof parsed !== "object") {
      return items;
    }

    const list = Array.isArray(parsed.items)
      ? parsed.items
      : Array.isArray(parsed.translations)
        ? parsed.translations
        : null;

    if (list) {
      return parseDeepSeekTranslationContent(list);
    }

    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const translatedText = Shared.normalizeSubtitleText(value);
        if (translatedText) {
          items.push({ id: String(id), translatedText });
        }
      }
    }

    return items;
  }

  Object.assign(Shared, { parseLooseJsonContent, parseDeepSeekTranslationContent });
});
