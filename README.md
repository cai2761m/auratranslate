[English](./README.md) | [简体中文](./README_zh.md)

# AuraTranslate

**Bilingual video subtitles and webpage reading, powered by your own translation API.**

AuraTranslate is a Manifest V3 browser extension that translates existing English subtitles on YouTube and Google Drive into Chinese, and adds translations below the original text on webpages. Choose Simplified or Traditional Chinese and connect an OpenAI-compatible Chat Completions API.

It uses existing caption tracks and transcripts. It does not record audio or transcribe videos without subtitles.

## Features

- **Bilingual video subtitles** — display English and Chinese together, drag the overlay to reposition it, and adjust subtitle size.
- **Progressive subtitle translation** — start near the current playback position, then prepare and translate additional caption windows as needed.
- **Economy mode** — translate the current position and the next 2 minutes by default. Choose a 1, 2, or 3-minute lookahead, or translate the full video.
- **Sentence-aware translation** — optional LLM sentence segmentation, correction of obvious auto-caption errors, and original technical terms alongside their translations.
- **Immersive webpage translation** — translate readable headings, paragraphs, lists, callouts, and page outlines while retaining the original text.
- **Inline formatting** — preserve common code, emphasis, links, and line breaks in new webpage translations, with a plain-text fallback when model output cannot preserve formatting.
- **Separate API settings** — use one API for subtitles and another for webpages, or share the subtitle configuration.
- **Local cache** — reuse saved subtitle and webpage translations across refreshes and background restarts. Cached webpage text appears before new API requests.

## Quick start

### 1. Install from source

Clone the repository, or download and extract its ZIP:

```sh
git clone https://github.com/cai2761m/auratranslate.git
```

In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `auratranslate` folder containing `manifest.json`.
4. Open AuraTranslate from the extensions menu and click **设置** (Settings).

No build step or npm installation is needed to load the extension. Node.js dependencies are only needed for development tests.

### 2. Configure your API

Under **实时字幕翻译 API** (Real-time subtitle API), enter:

| Setting | What to enter |
| --- | --- |
| Translation service | **OpenAI-compatible API**, the only service type in the settings UI |
| API Key | Your provider's API key |
| Base URL | Your provider's Chat Completions base URL, including its version path if required |
| Model | An exact model ID available through that endpoint |
| JSON output mode | Enabled by default; disable it if your endpoint rejects JSON response mode |

For example, `https://api.example.com/v1` becomes `https://api.example.com/v1/chat/completions`. A complete URL ending in `/chat/completions` is also accepted. This is a placeholder: replace it with your provider's actual endpoint. Do not enter a website homepage or a native API endpoint with a different protocol.

Under **沉浸式翻译 API** (Immersive translation API), keep **沿用实时字幕 API** to share these settings, or select **OpenAI-compatible API** and fill in a separate key, base URL, and model.

The **Google 翻译兜底** (Google fallback) selector is off by default. It provides two optional fallbacks for webpages:

- **Google 翻译（免 Key，可能限流）** uses an unofficial, keyless endpoint without Cloud API billing. It may be rate limited, blocked by your network, changed, or withdrawn; availability is not guaranteed.
- **Google Cloud Translation（官方 API）** uses the official Basic v2 NMT API. Enter a separate Cloud Translation API key, enable the API, and [enable billing](https://docs.cloud.google.com/translate/docs/setup). This is not a Gemini key. The first 500,000 characters per month have a free allowance; additional usage is charged under [Google's pricing](https://cloud.google.com/products/translate/pricing). The extension does not track or cap that allowance.

With fallback enabled, cached translations load first. If the primary API is unconfigured, fails, or omits paragraphs, only missing text is sent to the selected Google service. The primary API gets one attempt per batch before fallback; a timed-out primary request may already have been billed, and official Google fallback may add a separate charge. Google requests are not automatically retried. Successful paragraphs are cached even if later paragraphs fail; changing or disabling fallback keeps existing cached translations. To replace cached output, clear the translation cache (this can cause new charges).

Google fallback keeps code, links, and emphasis locally and translates text spans around them, which may reduce sentence context around formatting boundaries. It limits Google concurrency to two requests, bounds each request to 15 seconds, checks a 45-second fallback budget before sending each request, and cools down the keyless endpoint for 60 seconds after a failure while the background worker remains active. If both services fail, completed paragraphs stay visible and the remaining work pauses. Subtitle translation is unaffected.

Click **保存设置** (Save settings). The extension does not include an API key; API usage is billed according to your provider's terms.

### 3. Start translating

**YouTube:** open a video with English captions and keep **启用视频实时翻译** enabled in the popup. The extension reads the caption track and displays bilingual subtitles as translations become available. Drag the subtitle text to move it.

**Google Drive:** open a video that exposes a transcript. AuraTranslate briefly opens the transcript panel to read timestamped text, restores the panel, and displays bilingual subtitles inside the embedded player.

**Webpages:** open a page with readable English text and click the floating translation button on the right. Translations appear below the original text, with content near the viewport prioritized. Progress never pops up on its own while translating — hover the floating button to see it. Once translation finishes, click the button to hide or show translations. Drag the button vertically to reposition it.

## Subtitle settings

| Setting | Behavior and default |
| --- | --- |
| Translation scope | Economy mode by default; full-video mode also starts near playback before processing the rest |
| Lookahead | 2 minutes by default; choose 1, 2, or 3 minutes in economy mode |
| LLM sentence segmentation | Enabled; combines adjacent caption fragments into complete sentences before translation |
| ASR correction | Enabled; asks the model to correct obvious recognition errors in existing caption text |
| Original technical terms | Enabled; displays terms such as `翻译 (Translation)` in subtitle translations |
| Source / target language | English → Simplified Chinese by default; Traditional Chinese is also available |
| Subtitle size | `1.00×` by default; range `0.30×–3.00×`, in `0.05×` steps |
| Subtitle switch | Enabled; hides native subtitles while the custom subtitle overlay is active |

On smaller screens, try `0.50×–0.65×` and save. Font-size changes do not require new translations. LLM sentence segmentation uses the subtitle API and can generate additional requests; disabling it falls back to local caption merging.

## Cache and request behavior

Successful subtitle translations, prepared caption windows, and webpage translations are stored in `chrome.storage.local`.

- Visible webpage text uses small batches (up to 4 blocks and a target of 1,800 source characters, including formatting markers), separate from offscreen text. A longer individual paragraph stays intact. Offscreen batches remain larger, with at most three concurrent page requests; scrolling reprioritizes the next available slot. Smaller visible batches can add per-request prompt overhead.
- Cache checks display completed paragraphs even while the rest of their batch is still translating, including results from Google fallback.
- Refreshing a page reuses matching saved results and requests missing text. Fully cached content does not need another translation request.
- Changing the model, endpoint, language, or relevant subtitle processing settings can require new translations. Switching subtitle scope or lookahead preserves cached progress.
- Seeking or disabling subtitles adjusts work that has not yet been sent. Already-sent requests may finish and incur charges.
- Hidden webpage tabs pause new translation batches. Returning to the tab resumes pending work.
- While webpage requests are pending, read-only cache checks recover completed results even if the original response channel stalls. After an uncertain timeout or a closed channel, the visible page automatically checks for late results up to 12 times, five seconds apart, without replaying paid requests. Returning to the tab also checks the cache. Completed translations remain visible; click the button to manually continue missing work when necessary.
- **清空翻译缓存** clears subtitle and webpage translation caches. Subsequent translation may call the API again. Cache size is limited, so older entries can be evicted.

A refresh does not force the extension to fetch changed source captions when a prepared timeline is available. If a video's captions have been updated, clear the translation cache to read them again.

## Browser support and updates

The repository includes Chrome's service-worker background configuration and Firefox's background-script configuration. The manifest declares Firefox desktop **140+** and Firefox for Android **142+**.

For Android, use the website in Firefox with a Mozilla-signed extension package. This repository's source folder is not an installable signed package. Touch dragging and background recovery have automated coverage; that does not establish compatibility with every device or website. The native YouTube app is outside the extension's scope.

To update an unpacked installation:

1. Update the local source, for example with `git pull` if you cloned the repository.
2. Reload AuraTranslate in the browser's extension management page.
3. Refresh existing video and webpage tabs.

An installed signed extension needs an updated signed package. Pulling GitHub changes alone does not update that installation. Routine updates do not require clearing the cache.

## Privacy and permissions

| Permission / data | Purpose |
| --- | --- |
| `storage` | Save API settings, translation caches, subtitle position, and floating-button position locally |
| HTTP / HTTPS host access | Read supported page content, render translations, and call the configured API, including local endpoints |
| YouTube / Drive page access | Read caption metadata or transcript text and display the subtitle overlay |

Translation sends selected caption or webpage text to the API endpoint you configure. LLM sentence segmentation also sends caption text to that endpoint. API keys are stored in browser extension local storage; the project does not add encryption for stored keys. The password input masks the key on screen only.

Enabling Google fallback also allows missing webpage text to be sent to `translate.googleapis.com` (keyless) or `translation.googleapis.com` (official Cloud). Fallback requests omit browser cookies; the Cloud key is sent only to the official endpoint, independently of the AI API key.

The current source does not include a separate AuraTranslate account service or analytics endpoint. Your API provider handles the text you send under its own data policies.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No video subtitles | Enable the popup switch; confirm YouTube has English captions or Drive exposes a transcript. Videos without available text cannot be transcribed by this extension. |
| API key / model error | Check the key, exact model ID, and Chat Completions base URL. Confirm the account can access that model. |
| JSON output error | If the service rejects JSON response mode, disable it. If supported, enabling it can help the model return structured output. |
| Translation is slow | First results depend on caption retrieval and API latency. Use economy mode with a shorter lookahead to reduce queued work. |
| Webpage translation timeout | Keep the page open for automatic cache recovery, or return to the tab. If work remains incomplete, manually continue with the translation button. After updating the source, reload the extension and refresh the page. No cache clearing is needed. |
| Webpage content is skipped | Form controls, code blocks, decorative content, and explicitly excluded regions are skipped. Text in images, canvas, nested frames, or unsupported page structures may not be extracted. Each pass selects up to 240 text blocks. |
| Extension stops working after an update | Reload the extension and refresh the affected tabs. |
| Source captions changed but old text remains | Clear the translation cache in Settings, then refresh the video. |

When reporting an issue, include the browser/version, page URL, reproduction steps, and error text. Remove API keys and other private information from screenshots or logs.

## Development

The extension uses plain JavaScript, HTML, and CSS. Tests use Node's built-in test runner and jsdom. Use a Node.js version accepted by the locked jsdom dependency: `^22.22.2`, `^24.15.0`, or `>=26.0.0`.

```sh
npm ci
npm test
```

On Windows, use `npm.cmd ci` and `npm.cmd test` if PowerShell blocks `npm.ps1`.

The test suite covers caption parsing, configuration persistence, sentence segmentation, caching, webpage extraction and formatting, tab lifecycle recovery, message timeouts, and subtitle dragging. Tests simulate browser behavior; live API and device checks remain separate.

```text
manifest.json       Extension metadata, permissions, and entry points
src/
  background.js     API requests, cache persistence, and message routing
  content.js        Video captions, playback scheduling, and subtitle overlay
  drive.js          Drive transcript extraction and embedded-player bridge
  immersive.js      Webpage extraction, translation scheduling, and rendering
  shared.js         Settings, caption utilities, and API configuration
  page-bridge.js    YouTube player metadata and caption request bridge
  overlay.css       Subtitle styles
  immersive.css     Webpage translation styles
options/            Settings interface
popup/              Subtitle switch and settings entry point
test/               Automated tests and fixtures
```
