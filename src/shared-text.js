// Subtitle text normalization and display punctuation.
// Browser: register before shared.js. Node: shared.js calls this factory.
(function registerSharedModule(root, register) {
  if (typeof module !== "undefined" && module.exports) module.exports = register;
  else register(root.YTBTShared || (root.YTBTShared = {}));
})(globalThis, function (Shared) {
  "use strict";

  const DISPLAY_SENTENCE_END_RE = /[.!?]["')\]]?$/;
  const DISPLAY_BREAK_WORDS = new Set([
    "actually",
    "also",
    "anyway",
    "basically",
    "but",
    "finally",
    "first",
    "however",
    "instead",
    "like",
    "meanwhile",
    "next",
    "now",
    "second",
    "seems",
    "so",
    "then",
    "well"
  ]);
  const DISPLAY_PREPOSITION_WORDS = new Set([
    "about",
    "after",
    "as",
    "at",
    "before",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "onto",
    "over",
    "than",
    "through",
    "to",
    "under",
    "with",
    "without"
  ]);
  const DISPLAY_CLAUSE_END_WORDS = new Set(["bad", "done", "fine", "good", "ok", "okay", "work", "works"]);
  const DISPLAY_DISCOURSE_WORDS = new Set(["like", "so", "but", "then", "now", "well"]);
  const DISPLAY_PRONOUN_WORDS = new Set(["i", "we", "you", "he", "she", "they", "it", "this", "that", "there"]);
  const TAG_RE = /<[^>]+>/g;

  function decodeHtmlEntities(value) {
    if (!value) {
      return "";
    }

    const named = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " "
    };

    return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower[0] === "#") {
        const isHex = lower[1] === "x";
        const raw = isHex ? lower.slice(2) : lower.slice(1);
        const code = Number.parseInt(raw, isHex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
    });
  }

  function normalizeSubtitleText(value) {
    return decodeHtmlEntities(value)
      .replace(TAG_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isProtectedVideoContainer(node, overlay) {
    if (!node) {
      return false;
    }

    if (
      node === overlay ||
      (
        overlay &&
        typeof node.contains === "function" &&
        node.contains(overlay)
      )
    ) {
      return true;
    }

    if (
      typeof node.matches === "function" &&
      node.matches(
        "video, audio, #player, #movie_player, .html5-video-player, .html5-video-container"
      )
    ) {
      return true;
    }

    return Boolean(
      typeof node.querySelector === "function" &&
      node.querySelector("video, audio")
    );
  }

  function subtitleContentSignature(value) {
    return normalizeSubtitleText(value)
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function cleanDisplayWord(value) {
    return String(value || "").replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "").toLowerCase();
  }

  function capitalizeDisplaySentence(value) {
    return String(value || "")
      .replace(/\bi\b/g, "I")
      .replace(/(^|[.!?]\s+)([a-z])/g, (match, prefix, letter) => prefix + letter.toUpperCase());
  }

  function ensureDisplaySentenceEnd(value) {
    const text = String(value || "").trim();
    if (!text || DISPLAY_SENTENCE_END_RE.test(text)) {
      return text;
    }
    if (/[,;:]$/.test(text)) {
      return text.slice(0, -1) + ".";
    }
    return text + ".";
  }

  function polishDisplaySentence(value) {
    return ensureDisplaySentenceEnd(
      capitalizeDisplaySentence(value)
        .replace(/^(Like|So|Well|Now|Actually) I\b/, "$1, I")
        .replace(/^(Like|So|Well|Now|Actually) we\b/, "$1, we")
        .replace(/^(Like|So|Well|Now|Actually) you\b/, "$1, you")
    );
  }

  function findDisplayBreak(words, start, end) {
    const remaining = end - start;
    if (remaining <= 8) {
      return -1;
    }

    for (let index = start + 4; index <= end - 3; index += 1) {
      const word = cleanDisplayWord(words[index]);
      const previousWord = cleanDisplayWord(words[index - 1]);
      if ((word === "it's" || word === "it") && DISPLAY_CLAUSE_END_WORDS.has(previousWord)) {
        return index;
      }
    }

    const minOffset = 6;
    const idealOffset = 10;
    const maxOffset = 16;
    let bestIndex = -1;
    let bestScore = Infinity;

    for (let offset = minOffset; offset <= Math.min(maxOffset, remaining - 4); offset += 1) {
      const index = start + offset;
      const word = cleanDisplayWord(words[index]);
      const previousWord = cleanDisplayWord(words[index - 1]);
      if (!DISPLAY_BREAK_WORDS.has(word)) {
        continue;
      }
      if (DISPLAY_PREPOSITION_WORDS.has(previousWord)) {
        continue;
      }
      const score = Math.abs(offset - idealOffset) + (word === "seems" ? -2 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex > start) {
      return bestIndex;
    }

    for (let index = start + 2; index <= end - 4; index += 1) {
      const word = cleanDisplayWord(words[index]);
      const nextWord = cleanDisplayWord(words[index + 1]);
      const previousWord = cleanDisplayWord(words[index - 1]);
      if (DISPLAY_PREPOSITION_WORDS.has(previousWord)) {
        continue;
      }
      if (DISPLAY_DISCOURSE_WORDS.has(word) && DISPLAY_PRONOUN_WORDS.has(nextWord)) {
        return index;
      }
    }

    return -1;
  }

  function formatDisplaySourceText(value) {
    const text = normalizeSubtitleText(value);
    if (!text) {
      return "";
    }

    const normalized = text.replace(/\bi\b/g, "I");
    if (/[.!?]/.test(normalized)) {
      return ensureDisplaySentenceEnd(capitalizeDisplaySentence(normalized));
    }

    const words = normalized.split(" ");
    const sentences = [];
    let start = 0;
    while (start < words.length) {
      const breakIndex = findDisplayBreak(words, start, words.length);
      if (breakIndex > start) {
        sentences.push(words.slice(start, breakIndex).join(" "));
        start = breakIndex;
      } else {
        sentences.push(words.slice(start).join(" "));
        break;
      }
    }

    return sentences
      .map(polishDisplaySentence)
      .filter(Boolean)
      .join(" ");
  }

  Object.assign(Shared, {
    DISPLAY_PREPOSITION_WORDS,
    DISPLAY_PRONOUN_WORDS,
    decodeHtmlEntities,
    normalizeSubtitleText,
    isProtectedVideoContainer,
    subtitleContentSignature,
    cleanDisplayWord,
    formatDisplaySourceText
  });
});
