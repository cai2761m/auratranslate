// Chrome service worker entry. Firefox preloads the same dependencies through
// background.scripts in manifest.json. Register the receiver synchronously.
if (typeof importScripts === "function") {
  importScripts(
    "shared-settings.js",
    "shared-runtime.js",
    "shared-text.js",
    "shared-captions.js",
    "shared-translation.js",
    "shared-segmentation.js",
    "shared.js",
    "background-core.js",
    "background-subtitles.js",
    "background-immersive.js",
    "background-google.js",
    "background-requests.js",
    "background-bing.js",
    "background-cache.js"
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "TRANSLATE_BATCH") {
    handleTranslateBatch(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "TRANSLATE_RESULT",
          ok: false,
          videoId: message.videoId,
          items: [],
          errors: [{ message: error && error.message ? error.message : String(error) }]
        });
      });

    return true;
  }

  if (message.type === "SEGMENT_SUBTITLES") {
    handleSegmentSubtitles(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "SEGMENT_SUBTITLES_RESULT",
          ok: false,
          videoId: message.videoId,
          groups: [],
          errors: [{ message: error && error.message ? error.message : String(error) }]
        });
      });

    return true;
  }

  if (message.type === "IMMERSIVE_TRANSLATE") {
    handleImmersiveTranslate(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "IMMERSIVE_TRANSLATE_RESULT",
          ok: false,
          items: [],
          errors: [{ message: error && error.message ? error.message : String(error) }]
        });
      });

    return true;
  }

  return false;
});
