# AuraTranslate

AuraTranslate is a Chrome Manifest V3 extension for AI-powered bilingual reading. It provides real-time Chinese-English subtitles on YouTube and Google Drive videos, plus immersive bilingual webpage translation on regular sites.

The extension does not perform audio recognition. Video subtitle translation is based on existing YouTube caption tracks or Google Drive transcripts, while webpage translation extracts readable page text and translates it through your configured LLM API.

## Highlights

- YouTube bilingual subtitles: detects English caption tracks, translates them into Simplified or Traditional Chinese, and renders a draggable bilingual overlay on the video.
- Google Drive bilingual subtitles: reads an available Drive video transcript, pre-translates it, and renders the same overlay inside the embedded player.
- Immersive webpage translation: adds a small side-docked floating translate button on normal webpages; click it to insert Chinese translations below the original text.
- Separate API profiles: configure one LLM API for real-time subtitle translation and another for immersive webpage translation, or let immersive translation reuse the subtitle API.
- Multiple providers: supports DeepSeek, Gemini, and custom OpenAI-compatible Chat Completions APIs.
- LLM sentence segmentation: enabled by default, it regroups adjacent caption cues into complete sentences before translation and can be disabled in Settings.
- ASR correction: optionally asks the model to fix obvious auto-caption recognition errors before translating.
- Original technical terms: optionally appends source terms after translated terminology, such as `翻译 (Translation)`; enabled by default.
- Priority scheduling: translates captions near the current playback position first, then continues pre-translating the rest of the video.
- Translation cache: stores successful subtitle translations in `chrome.storage.local` to reduce repeated API calls.
- Draggable controls: subtitle overlay position and immersive translate button position are persisted locally.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the project folder.
6. Click the AuraTranslate extension icon, then click `Settings` to configure API keys.

## Usage

### YouTube Subtitles

1. Open a YouTube video that has English captions.
2. AuraTranslate reads the available caption track.
3. Captions are merged, translated, cached, and displayed as Chinese-English subtitles on top of the video.
4. Drag the subtitle overlay to reposition it.

### Google Drive Subtitles

1. Open a Google Drive video that has a transcript.
2. AuraTranslate briefly opens the transcript panel to read its timestamped cues, then restores the panel.
3. The transcript is merged, translated, cached, and displayed inside the Drive video player.

### Immersive Webpage Translation

1. Open a regular webpage with readable English content.
2. Click the small floating translation button docked on the right side of the page.
3. AuraTranslate translates headings, paragraphs, list items, blockquotes, captions, and common article header text.
4. Chinese translations are inserted near the original text for side-by-side reading.
5. Drag the floating button up or down to reposition it.

## Configuration

Open the extension popup and click `Settings`.

### Real-Time Subtitle Translation API

This API profile is used by YouTube subtitle translation.

| Field | Description |
| --- | --- |
| Translation Provider | DeepSeek, Gemini, or a custom OpenAI-compatible API |
| API Key | API key for the selected provider |
| Base URL | API endpoint; DeepSeek and Gemini can be auto-filled |
| Model | Model name; DeepSeek and Gemini can be auto-filled |
| JSON Response Mode | Requests structured JSON output when supported |

### Immersive Translation API

This API profile is used by webpage translation.

By default, immersive translation reuses the real-time subtitle API. Select a provider in this section only when you want immersive translation to call a different API, model, or endpoint.

### General Settings

| Setting | Description |
| --- | --- |
| LLM Sentence Segmentation | Regroups cross-cue sentences with the real-time subtitle model before translation; enabled by default |
| ASR Correction | Fix obvious YouTube auto-caption recognition errors before translation |
| Original Technical Terms | Appends source-language terms after translated subtitle terminology; enabled by default |
| Source Language | Currently English |
| Target Language | Simplified Chinese or Traditional Chinese |
| Font Scale | Subtitle overlay size, from `0.7x` to `1.8x` |
| Subtitle Enabled | Enables the custom subtitle overlay and hides native YouTube CC captions |

## Provider Notes

### DeepSeek

DeepSeek is the default provider. You usually only need to provide an API key.

Default base URL:

```text
https://api.deepseek.com
```

Default model:

```text
deepseek-v4-flash
```

### Gemini

Gemini uses Google's GenerateContent API.

Default base URL:

```text
https://generativelanguage.googleapis.com/v1beta
```

Default model:

```text
gemini-3.5-flash
```

### Custom OpenAI-Compatible API

Use this option for relay services or model providers that implement the OpenAI Chat Completions API.

Example:

| Field | Example |
| --- | --- |
| API Key | `sk-...` |
| Base URL | `https://api.example.com/v1` |
| Model | `model-name` |

If your provider does not support OpenAI JSON mode, disable `JSON Response Mode`. AuraTranslate will still try to recover usable translation JSON from the model response.

## Cache Behavior

Subtitle translations are cached by:

- video id
- caption track fingerprint
- provider
- API endpoint
- model
- source language
- target language
- ASR correction mode
- original technical-term display mode
- LLM sentence segmentation mode and version
- caption merge version
- cache version

A new API request is expected when a cue has not been translated before, the API configuration changes, the source or target language changes, LLM sentence segmentation, ASR correction, or original technical-term display changes, the cache is cleared, or the segmentation/merge algorithm version changes. Sentence segmentation results are cached separately and reused for the same video, track, model, and source language.

Immersive webpage translations are currently generated on demand and inserted into the page during the current session.

## Permissions

AuraTranslate uses:

- `storage`: saves API settings, subtitle cache, overlay position, and floating button position.
- `https://www.youtube.com/*`: reads YouTube caption metadata and renders bilingual subtitles.
- `https://drive.google.com/file/*` and `https://youtube.googleapis.com/embed/*`: read Drive transcript cues and render subtitles inside its embedded player.
- `http://*/*` and `https://*/*`: injects the immersive webpage translation button and translation renderer.

## Project Structure

```text
manifest.json              Chrome extension manifest
package.json               Project metadata and npm scripts
src/
  background.js            Service worker for API calls, cache, and message routing
  content.js               Video caption loading, translation queue, and subtitle overlay
  drive.js                 Google Drive transcript extraction and player bridge
  immersive.js             Webpage text extraction and immersive translation renderer
  shared.js                Shared settings, caption parsing, merging, and config helpers
  overlay.css              YouTube subtitle overlay styles
  immersive.css            Webpage translation button and inline translation styles
  page-bridge.js           Injected YouTube page bridge for player metadata
popup/
  popup.html               Lightweight extension popup
  popup.css                Popup styles
  popup.js                 Opens the options page from the popup
options/
  options.html             Settings page
  options.css              Settings page styles
  options.js               Settings persistence and provider switching
test/
  subtitle-utils.test.js   Unit tests for parsing, merging, config, and errors
```

## Development

Run tests:

```powershell
node --test
```

Check JavaScript syntax:

```powershell
node --check src\background.js
node --check src\content.js
node --check src\immersive.js
node --check options\options.js
node --check popup\popup.js
```

If PowerShell blocks `npm.ps1`, run `node --test` directly or use:

```powershell
npm.cmd test
```

## Troubleshooting

- No YouTube subtitles: confirm the video has an English caption track available in YouTube's native CC menu.
- No Google Drive subtitles: confirm the video exposes the Drive transcript panel; AuraTranslate does not transcribe audio itself.
- API key error: open AuraTranslate settings and confirm the provider, API key, base URL, and model.
- Translation returns malformed content: try enabling `JSON Response Mode`; if the provider does not support it, disable it and retry.
- Immersive translation misses content: some websites render text in custom components or protected regions. Try refreshing the page, scrolling the content into view, then clicking the floating button again.
- Native YouTube captions still appear: turn off YouTube's CC button or reload the page after enabling AuraTranslate subtitles.

## License

MIT
