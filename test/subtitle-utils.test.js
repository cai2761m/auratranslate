const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const Core = require("../src/shared.js");

test("parseJson3Captions extracts YouTube json3 events", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "captions.json"), "utf8")
  );

  const cues = Core.parseJson3Captions(fixture);
  assert.equal(cues.length, 4);
  assert.deepEqual(cues[0], {
    startMs: 0,
    endMs: 900,
    sourceText: "Hello"
  });
  assert.equal(cues[3].sourceText, "a test & demo");
});

test("parseVttCaptions handles cue ids, settings, and HTML cleanup", () => {
  const cues = Core.parseVttCaptions(`
WEBVTT

1
00:00:01.000 --> 00:00:02.500 align:start
<c>Hello</c> &amp; welcome

00:00:03.000 --> 00:00:04.000
Next line
`);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[0].sourceText, "Hello & welcome");
});

test("parseXmlCaptions handles transcript text captions", () => {
  const cues = Core.parseXmlCaptions(`
<transcript>
  <text start="1.25" dur="2.5">Hello &amp; welcome</text>
  <text start="4" dur="1">Next line</text>
</transcript>
`);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1250);
  assert.equal(cues[0].endMs, 3750);
  assert.equal(cues[0].sourceText, "Hello & welcome");
});

test("parseXmlCaptions handles srv3 paragraph captions", () => {
  const cues = Core.parseXmlCaptions(`
<timedtext>
  <body>
    <p t="1000" d="2500"><s>Hello</s><s> world.</s></p>
  </body>
</timedtext>
`);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(cues[0].sourceText, "Hello world.");
});

test("parseXmlCaptions handles ttml begin and end times", () => {
  const cues = Core.parseXmlCaptions(`
<tt>
  <body>
    <div>
      <p begin="00:00:02.000" end="00:00:03.500">Timed text</p>
    </div>
  </body>
</tt>
`);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 2000);
  assert.equal(cues[0].endMs, 3500);
});

test("parseYouTubeTranscriptResponse extracts transcript segments", () => {
  const cues = Core.parseYouTubeTranscriptResponse({
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        {
                          transcriptSegmentRenderer: {
                            startMs: "1000",
                            endMs: "2500",
                            snippet: {
                              runs: [{ text: "Hello" }, { text: " world." }]
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    ]
  });

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[0].sourceText, "Hello world.");
});

test("parseGoogleDriveTranscriptItems infers cue ends from the next timestamp", () => {
  const cues = Core.parseGoogleDriveTranscriptItems([
    { startMs: 8240, sourceText: " Second &amp; cleaned " },
    { startMs: 640, sourceText: "First cue" },
    { startMs: 3919, sourceText: "Middle cue" },
    { startMs: 3919, sourceText: "Middle cue" },
    { startMs: "invalid", sourceText: "Ignored" }
  ]);

  assert.deepEqual(cues, [
    { startMs: 640, endMs: 3919, sourceText: "First cue" },
    { startMs: 3919, endMs: 8240, sourceText: "Middle cue" },
    { startMs: 8240, endMs: 13240, sourceText: "Second & cleaned" }
  ]);
});

test("player containers are protected from native-caption hiding", () => {
  const overlay = {};
  const playerRoot = {
    contains(node) {
      return node === overlay;
    },
    matches(selector) {
      return selector.includes("#player");
    },
    querySelector(selector) {
      return selector === "video, audio" ? {} : null;
    }
  };
  const videoAncestor = {
    contains() {
      return false;
    },
    matches() {
      return false;
    },
    querySelector(selector) {
      return selector === "video, audio" ? {} : null;
    }
  };
  const captionNode = {
    contains() {
      return false;
    },
    matches() {
      return false;
    },
    querySelector() {
      return null;
    }
  };

  assert.equal(Core.isProtectedVideoContainer(playerRoot, overlay), true);
  assert.equal(Core.isProtectedVideoContainer(videoAncestor, null), true);
  assert.equal(Core.isProtectedVideoContainer(captionNode, overlay), false);
});

test("findYouTubeTranscriptParams locates nested transcript endpoint params", () => {
  const params = Core.findYouTubeTranscriptParams(
    {
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            content: {
              continuationItemRenderer: {
                continuationEndpoint: {
                  getTranscriptEndpoint: {
                    params: "abc123"
                  }
                }
              }
            }
          }
        }
      ]
    },
    0
  );

  assert.equal(params, "abc123");
});

test("mergeCaptionFragments combines small fragments into sentence cues", () => {
  const raw = [
    { startMs: 0, endMs: 500, sourceText: "Hello" },
    { startMs: 650, endMs: 1000, sourceText: "world." },
    { startMs: 1100, endMs: 1500, sourceText: "New" },
    { startMs: 1700, endMs: 2100, sourceText: "idea" }
  ];

  const merged = Core.mergeCaptionFragments(raw);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].sourceText, "Hello world.");
  assert.equal(merged[1].sourceText, "New idea");
  assert.equal(merged[1].displaySourceText, "New idea.");
  assert.equal(merged[0].id, "0");
  assert.equal(merged[1].id, "1");
});

test("formatDisplaySourceText punctuates plain ASR English for display", () => {
  assert.equal(
    Core.formatDisplaySourceText(
      "basically identical just from an aesthetic point of view seems bad like i don't like the idea of having code"
    ),
    "Basically identical just from an aesthetic point of view. Seems bad. Like, I don't like the idea of having code."
  );
});

test("formatDisplaySourceText does not break prepositional phrases", () => {
  const display = Core.formatDisplaySourceText(
    "we talked about the idea of having two versions of this longest method and that'll work it's a way to get a longest"
  );

  assert.equal(
    display,
    "We talked about the idea of having two versions of this longest method and that'll work. It's a way to get a longest."
  );
  assert.doesNotMatch(display, /of\. This/);
});

test("mergeCaptionFragments preserves raw source while formatting display text", () => {
  const raw = [
    { startMs: 0, endMs: 500, sourceText: "basically identical" },
    { startMs: 600, endMs: 1000, sourceText: "just from an aesthetic point of view" },
    { startMs: 1100, endMs: 1500, sourceText: "seems bad" },
    { startMs: 1600, endMs: 2000, sourceText: "like i don't like the idea" },
    { startMs: 2100, endMs: 2500, sourceText: "of having code" }
  ];

  const merged = Core.mergeCaptionFragments(raw);
  assert.equal(merged.length, 1);
  assert.equal(
    merged[0].sourceText,
    "basically identical just from an aesthetic point of view seems bad like i don't like the idea of having code"
  );
  assert.equal(
    merged[0].displaySourceText,
    "Basically identical just from an aesthetic point of view. Seems bad. Like, I don't like the idea of having code."
  );
});

test("mergeCaptionFragments breaks on long gaps", () => {
  const raw = [
    { startMs: 0, endMs: 500, sourceText: "Alpha" },
    { startMs: 2000, endMs: 2500, sourceText: "Beta" }
  ];

  const merged = Core.mergeCaptionFragments(raw);
  assert.equal(merged.length, 2);
});

test("mergeCaptionFragments keeps dangling phrase endings with the next cue", () => {
  const raw = [
    { startMs: 0, endMs: 1000, sourceText: "just remember it's it's following your" },
    { startMs: 1100, endMs: 1600, sourceText: "nose." }
  ];

  const merged = Core.mergeCaptionFragments(raw, {
    maxChars: 32,
    hardMaxChars: 120
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceText, "just remember it's it's following your nose.");
});

test("mergeCaptionFragments keeps technical compound terms together", () => {
  const raw = [
    {
      startMs: 0,
      endMs: 2000,
      sourceText: "are there any things that we like better about the doubly."
    },
    { startMs: 2100, endMs: 2600, sourceText: "Linked list?" }
  ];

  const merged = Core.mergeCaptionFragments(raw, {
    maxChars: 60,
    hardMaxChars: 160
  });

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0].sourceText,
    "are there any things that we like better about the doubly linked list?"
  );
});

test("mergeCaptionFragments still breaks at soft limits for complete phrases", () => {
  const raw = [
    { startMs: 0, endMs: 1000, sourceText: "This part is complete enough" },
    { startMs: 1100, endMs: 1600, sourceText: "Next idea starts here" }
  ];

  const merged = Core.mergeCaptionFragments(raw, {
    maxChars: 28,
    hardMaxChars: 120
  });

  assert.equal(merged.length, 2);
});

test("sentence segmentation input isolates a trailing partial sentence", () => {
  const cues = Core.splitCaptionCuesAtSentenceBoundaries([
    {
      id: "0",
      startMs: 1000,
      endMs: 7000,
      sourceText: "Multiplicative constants do not help. For example, if n"
    },
    {
      id: "1",
      startMs: 7100,
      endMs: 9000,
      sourceText: "doubles, then 8n will also double."
    }
  ]);

  assert.equal(cues.length, 3);
  assert.equal(cues[0].sourceText, "Multiplicative constants do not help.");
  assert.equal(cues[1].sourceText, "For example, if n");
  assert.equal(cues[2].sourceText, "doubles, then 8n will also double.");
  assert.equal(cues[0].id, "0");
  assert.equal(cues[2].id, "2");
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[1].endMs, 7000);
  assert.equal(cues[2].startMs, 7100);
});

test("LLM sentence segmentation rejoins a sentence split across local cues", () => {
  const cues = [
    {
      id: "0",
      startMs: 1000,
      endMs: 4000,
      sourceText: "For example, if n",
      displaySourceText: "For example, if n.",
      translatedText: "",
      status: "pending"
    },
    {
      id: "1",
      startMs: 4100,
      endMs: 7000,
      sourceText: "doubles, then 8n will also double.",
      displaySourceText: "Doubles, then 8n will also double.",
      translatedText: "",
      status: "pending"
    },
    {
      id: "2",
      startMs: 7200,
      endMs: 9000,
      sourceText: "That is the next idea.",
      displaySourceText: "That is the next idea.",
      translatedText: "",
      status: "pending"
    }
  ];
  const groups = Core.parseSentenceSegmentationContent(
    JSON.stringify({
      groups: [
        {
          startId: "0",
          endId: "1",
          displaySourceText: "For example, if n doubles, then 8n will also double."
        },
        {
          startId: "2",
          endId: "2",
          displaySourceText: "That is the next idea."
        }
      ]
    }),
    cues
  );
  const segmented = Core.applySentenceSegmentationGroups(cues, groups);

  assert.equal(segmented.length, 2);
  assert.equal(segmented[0].startMs, 1000);
  assert.equal(segmented[0].endMs, 7000);
  assert.equal(
    segmented[0].sourceText,
    "For example, if n doubles, then 8n will also double."
  );
  assert.equal(
    segmented[0].displaySourceText,
    "For example, if n doubles, then 8n will also double."
  );
  assert.equal(segmented[1].id, "1");
});

test("LLM sentence segmentation rejects gaps in cue coverage", () => {
  const cues = [
    { id: "0", startMs: 0, endMs: 1000, sourceText: "First" },
    { id: "1", startMs: 1000, endMs: 2000, sourceText: "second" }
  ];

  assert.throws(
    () =>
      Core.parseSentenceSegmentationContent(
        '{"groups":[{"startId":"1","endId":"1","displaySourceText":"Second."}]}',
        cues
      ),
    /cover consecutive cue ids/i
  );
});

test("LLM sentence segmentation ignores display text that changes source words", () => {
  const cues = [
    { id: "0", startMs: 0, endMs: 1000, sourceText: "Keep every word" }
  ];
  const groups = Core.parseSentenceSegmentationContent(
    '{"groups":[{"startId":"0","endId":"0","displaySourceText":"Invent different words."}]}',
    cues
  );
  const segmented = Core.applySentenceSegmentationGroups(cues, groups);

  assert.equal(groups[0].displaySourceText, undefined);
  assert.equal(segmented[0].displaySourceText, "Keep every word.");
});

test("findCueAtTime returns the active cue by binary search", () => {
  const cues = [
    { startMs: 0, endMs: 1000, sourceText: "A" },
    { startMs: 2000, endMs: 3000, sourceText: "B" }
  ];

  assert.equal(Core.findCueAtTime(cues, 2500).sourceText, "B");
  assert.equal(Core.findCueAtTime(cues, 1500), null);
});

test("parseDeepSeekTranslationContent accepts common JSON shapes", () => {
  assert.deepEqual(
    Core.parseDeepSeekTranslationContent('{"items":[{"id":"1","translatedText":"你好"}]}'),
    [{ id: "1", translatedText: "你好" }]
  );
  assert.deepEqual(Core.parseDeepSeekTranslationContent('{"2":"世界"}'), [
    { id: "2", translatedText: "世界" }
  ]);
  assert.deepEqual(
    Core.parseDeepSeekTranslationContent(
      '{"items":[{"id":"3","translatedText":"translated","displaySourceText":"hello world"}]}'
    ),
    [{ id: "3", translatedText: "translated", displaySourceText: "Hello world." }]
  );
  assert.deepEqual(
    Core.parseDeepSeekTranslationContent(
      '```json\n{"items":[{"id":"4","translatedText":"ok","displaySourceText":"it works"}]}\n```'
    ),
    [{ id: "4", translatedText: "ok", displaySourceText: "It works." }]
  );
  assert.deepEqual(
    Core.parseDeepSeekTranslationContent(
      '{"items":[{"id":"5","translatedText":"他说 "Hello" 吧"}]}'
    ),
    [{ id: "5", translatedText: '他说 "Hello" 吧' }]
  );
});

test("cache keys are stable and namespaced", () => {
  const key = Core.makeCacheKey(["video", "track", "model"]);
  assert.match(key, /^ytbt:/);
  assert.equal(key, Core.makeCacheKey(["video", "track", "model"]));
});

test("resolveTranslationConfig keeps old DeepSeek API key compatible", () => {
  const config = Core.resolveTranslationConfig({
    deepseekApiKey: "old-key"
  });

  assert.equal(config.provider, "deepseek");
  assert.equal(config.apiKey, "old-key");
  assert.equal(config.model, Core.DEEPSEEK_MODEL);
  assert.equal(config.chatCompletionsUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(config.includeDeepSeekThinkingFlag, true);
});

test("default settings enable ASR correction", () => {
  assert.equal(Core.DEFAULT_SETTINGS.asrCorrectionEnabled, true);
});

test("default settings enable LLM sentence segmentation", () => {
  assert.equal(Core.DEFAULT_SETTINGS.llmSentenceSegmentationEnabled, true);
});

test("default settings show original technical terms", () => {
  assert.equal(Core.DEFAULT_SETTINGS.showOriginalTechnicalTerms, true);
});

test("technical terminology prompt follows the display setting", () => {
  assert.match(Core.buildTechnicalTerminologyInstruction(true), /append the original source term/i);
  assert.match(Core.buildTechnicalTerminologyInstruction(false), /do not append or repeat/i);
});

test("resolveTranslationConfig supports custom OpenAI-compatible API", () => {
  const config = Core.resolveTranslationConfig({
    translationProvider: "custom",
    translationApiKey: "custom-key",
    translationBaseUrl: "https://api.example.com/v1/",
    translationModel: "custom-model",
    translationJsonResponse: false
  });

  assert.equal(config.provider, "custom");
  assert.equal(config.apiKey, "custom-key");
  assert.equal(config.model, "custom-model");
  assert.equal(config.chatCompletionsUrl, "https://api.example.com/v1/chat/completions");
  assert.equal(config.useJsonResponseFormat, false);
  assert.equal(config.includeDeepSeekThinkingFlag, false);
});

test("resolveTranslationConfig lets immersive translation inherit realtime API", () => {
  const config = Core.resolveTranslationConfig(
    {
      translationProvider: "custom",
      translationApiKey: "realtime-key",
      translationBaseUrl: "https://api.example.com/v1",
      translationModel: "realtime-model"
    },
    "immersive"
  );

  assert.equal(config.provider, "custom");
  assert.equal(config.apiKey, "realtime-key");
  assert.equal(config.model, "realtime-model");
  assert.equal(config.chatCompletionsUrl, "https://api.example.com/v1/chat/completions");
});

test("resolveTranslationConfig supports dedicated immersive API", () => {
  const config = Core.resolveTranslationConfig(
    {
      translationProvider: "custom",
      translationApiKey: "realtime-key",
      translationBaseUrl: "https://api.example.com/v1",
      translationModel: "realtime-model",
      immersiveTranslationProvider: "gemini",
      immersiveTranslationApiKey: "immersive-key",
      immersiveTranslationJsonResponse: false
    },
    "immersive"
  );

  assert.equal(config.provider, "gemini");
  assert.equal(config.apiKey, "immersive-key");
  assert.equal(config.baseUrl, Core.GEMINI_BASE_URL);
  assert.equal(config.model, Core.GEMINI_MODEL);
  assert.equal(config.useJsonResponseFormat, false);
});

test("resolveTranslationConfig supports Gemini API", () => {
  const config = Core.resolveTranslationConfig({
    translationProvider: "gemini",
    translationApiKey: "gemini-key"
  });

  assert.equal(config.provider, "gemini");
  assert.equal(config.providerLabel, "Gemini");
  assert.equal(config.apiStyle, "gemini");
  assert.equal(config.apiKey, "gemini-key");
  assert.equal(config.baseUrl, Core.GEMINI_BASE_URL);
  assert.equal(config.model, Core.GEMINI_MODEL);
  assert.equal(config.chatCompletionsUrl, "");
  assert.equal(
    config.generateContentUrl,
    `${Core.GEMINI_BASE_URL}/models/${Core.GEMINI_MODEL}:generateContent`
  );
});

test("resolveTranslationConfig ignores stale provider defaults after switching to Gemini", () => {
  const config = Core.resolveTranslationConfig({
    translationProvider: "gemini",
    translationApiKey: "gemini-key",
    translationBaseUrl: Core.DEEPSEEK_BASE_URL,
    translationModel: Core.DEEPSEEK_MODEL
  });

  assert.equal(config.baseUrl, Core.GEMINI_BASE_URL);
  assert.equal(config.model, Core.GEMINI_MODEL);
  assert.equal(
    config.generateContentUrl,
    `${Core.GEMINI_BASE_URL}/models/${Core.GEMINI_MODEL}:generateContent`
  );
});

test("buildChatCompletionsUrl accepts full endpoint URLs", () => {
  assert.equal(
    Core.buildChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions"
  );
});

test("buildGeminiGenerateContentUrl accepts plain and prefixed model names", () => {
  assert.equal(
    Core.buildGeminiGenerateContentUrl(Core.GEMINI_BASE_URL, "gemini-3.5-flash"),
    `${Core.GEMINI_BASE_URL}/models/gemini-3.5-flash:generateContent`
  );
  assert.equal(
    Core.buildGeminiGenerateContentUrl(Core.GEMINI_BASE_URL, "models/gemini-3.5-flash"),
    `${Core.GEMINI_BASE_URL}/models/gemini-3.5-flash:generateContent`
  );
  assert.equal(
    Core.buildGeminiGenerateContentUrl(
      `${Core.GEMINI_BASE_URL}/models/gemini-3.5-flash:generateContent`,
      "ignored"
    ),
    `${Core.GEMINI_BASE_URL}/models/gemini-3.5-flash:generateContent`
  );
});

test("sourceLanguageLabel and targetLanguageLabel resolve known and regional codes", () => {
  assert.equal(Core.sourceLanguageLabel("en"), "English");
  assert.equal(Core.sourceLanguageLabel("en-US"), "English");
  assert.equal(Core.sourceLanguageLabel(undefined), "English");

  assert.equal(Core.targetLanguageLabel("zh-CN"), "Simplified Chinese");
  assert.equal(Core.targetLanguageLabel("zh-TW"), "Traditional Chinese");
  // Unknown codes fall back to Simplified Chinese (the default target).
  assert.equal(Core.targetLanguageLabel("ja"), "Simplified Chinese");
  assert.equal(Core.targetLanguageLabel(""), "Simplified Chinese");
});

test("classifyTranslationError marks transient failures as retryable", () => {
  assert.equal(Core.classifyTranslationError("request failed (429): too many requests"), "retryable");
  assert.equal(Core.classifyTranslationError("Gemini request failed (429): TooManyRequests"), "retryable");
  assert.equal(Core.classifyTranslationError("rate limit exceeded"), "retryable");
  assert.equal(Core.classifyTranslationError("Gemini request failed (503): ServiceUnavailable"), "retryable");
  assert.equal(Core.classifyTranslationError("DeepSeek request failed (503): unavailable"), "retryable");
  assert.equal(Core.classifyTranslationError("timeout"), "retryable");
  assert.equal(Core.classifyTranslationError("failed to fetch"), "retryable");
  assert.equal(Core.classifyTranslationError("response truncated (finish_reason=length)"), "retryable");
  assert.equal(Core.classifyTranslationError("returned non-JSON response."), "retryable");
  assert.equal(
    Core.classifyTranslationError("Invalid translation JSON: Expected ',' or '}' after property value in JSON at position 793"),
    "retryable"
  );
});

test("classifyTranslationError marks config and auth errors as fatal", () => {
  assert.equal(Core.classifyTranslationError("DeepSeek API Key is not configured."), "fatal");
  assert.equal(Core.classifyTranslationError("request failed (401): unauthorized"), "fatal");
  assert.equal(Core.classifyTranslationError("request failed (403): forbidden"), "fatal");
  assert.equal(Core.classifyTranslationError("quota exceeded"), "fatal");
  assert.equal(Core.classifyTranslationError("insufficient quota"), "fatal");
});

test("classifyTranslationError treats unrecognised messages as unknown", () => {
  assert.equal(Core.classifyTranslationError("something unexpected happened"), "unknown");
  assert.equal(Core.classifyTranslationError(""), "unknown");
});
