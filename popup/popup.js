(function runPopup() {
  "use strict";
  const Core = globalThis.YTBTCore;
  const $ = (selector) => document.querySelector(selector);
  let settings;
  let tab;
  let hostname = "";
  let page = null;
  let saving = false;

  $("#open-settings").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(() => window.close());
    else chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") }, () => window.close());
  });
  $("#more-toggle").addEventListener("click", () => {
    const expanded = $("#more-toggle").getAttribute("aria-expanded") !== "true";
    $("#more-toggle").setAttribute("aria-expanded", String(expanded));
    $("#more-panel").hidden = !expanded;
    $(".popup").classList.toggle("more-open", expanded);
  });
  init().catch((error) => status(`无法读取设置：${error.message}`, true));

  function api(invoke) {
    return new Promise((resolve, reject) => invoke((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    }));
  }
  function message(type) {
    return api((done) => chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 }, done));
  }
  function status(text, error = false) {
    $("#status").textContent = text;
    $("#status").dataset.error = String(error);
  }
  async function init() {
    $("#version").textContent = `v${chrome.runtime.getManifest().version}`;
    settings = await api((done) => chrome.storage.local.get(Core.DEFAULT_SETTINGS, done));
    const config = Core.resolveTranslationConfig(settings, "immersive");
    $("#translation-service option[value='ai']").textContent = `AI 翻译 · ${config.model || "请先配置模型"}`;
    $("#source-language").value = settings.immersiveSourceLanguage;
    $("#target-language").value = settings.immersiveTargetLanguage || settings.targetLanguage;
    $("#translation-service").value = settings.immersiveTranslationService;
    $("#subtitle-enabled-toggle").checked = settings.subtitleEnabled !== false;
    $("#auto-translate-toggle").checked = settings.immersiveAutoTranslate === true;
    renderMode();
    try {
      [tab] = await api((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
      const url = new URL(tab?.url || "");
      if (/^https?:$/.test(url.protocol)) hostname = url.hostname;
    } catch (_) { /* Settings remain usable on restricted browser pages. */ }
    $("#site-name").textContent = hostname || "当前页面不支持网页翻译";
    renderSite();
    if (hostname) {
      try { page = await message("IMMERSIVE_POPUP_STATUS"); } catch (_) { /* Older tabs need a refresh. */ }
    }
    renderControls();
    pageStatus();
    $("#source-language").addEventListener("change", (event) => save({ immersiveSourceLanguage: event.target.value }));
    $("#target-language").addEventListener("change", (event) => save({ immersiveTargetLanguage: event.target.value }));
    $("#translation-service").addEventListener("change", (event) => save({ immersiveTranslationService: event.target.value }));
    $("#subtitle-enabled-toggle").addEventListener("change", (event) => save({ subtitleEnabled: event.target.checked }));
    $("#auto-translate-toggle").addEventListener("change", (event) => save({ immersiveAutoTranslate: event.target.checked }));
    $("#display-mode-toggle").addEventListener("click", () => saveMode(settings.immersiveDisplayMode === "translation" ? "bilingual" : "translation"));
    document.querySelectorAll("[data-display-mode]").forEach((button) => button.addEventListener("click", () => saveMode(button.dataset.displayMode)));
    document.querySelectorAll("[data-site-rule]").forEach((button) => button.addEventListener("click", () => {
      const rules = { ...settings.immersiveSiteRules };
      if (button.dataset.siteRule === "inherit") delete rules[hostname];
      else rules[hostname] = button.dataset.siteRule;
      save({ immersiveSiteRules: rules });
    }));
    $("#translate-page").addEventListener("click", async () => {
      $("#translate-page").disabled = true;
      try {
        const response = await message("IMMERSIVE_POPUP_TRANSLATE");
        if (!response?.ok) throw new Error(response?.error || "网页未响应");
        page = response;
        pageStatus();
      } catch (error) { status(`无法启动翻译，请刷新网页后重试。${error.message}`, true); }
      renderControls();
    });
    // Short status probes never initiate a translation request.
    setInterval(async () => {
      if (!hostname || saving) return;
      try {
        const previous = `${page?.mode}:${page?.status}`;
        page = await message("IMMERSIVE_POPUP_STATUS");
        renderControls();
        if (previous !== `${page?.mode}:${page?.status}`) pageStatus();
      } catch (_) { /* Keep the last useful status when a tab closes. */ }
    }, 1000);
  }
  function renderControls() {
    const running = page?.mode === "translating";
    for (const selector of ["#source-language", "#target-language", "#translation-service"]) $(selector).disabled = saving || running;
    for (const selector of ["#display-mode-toggle", "#display-controls", "#auto-translate-toggle", "#subtitle-enabled-toggle"]) $(selector).disabled = saving;
    $("#site-controls").disabled = saving || !hostname;
    $("#translate-page").disabled = saving || running || !page?.ok;
    $("#translate-label").textContent = running ? "正在翻译…" : "翻译当前网页";
  }
  function pageStatus() {
    if (!hostname) status("请在普通网页中使用翻译，设置仍可修改。");
    else if (!page?.ok) status("请刷新当前网页，让扩展连接后再翻译。");
    else if (page.mode === "translating") status("正在翻译，完成后会直接显示在网页中。");
    else if (page.translated) status("网页翻译已完成，可随时切换双语或仅译文。");
    else if (page.status) status(page.status, page.mode === "error");
    else status(settings.immersiveDisplayMode === "translation" ? "仅显示译文" : "原文与译文对照显示");
  }
  function renderMode() {
    const translation = settings.immersiveDisplayMode === "translation";
    $("#mode-icon").textContent = translation ? "A" : "文/A";
    $("#display-mode-toggle").setAttribute("aria-label", translation ? "切换为双语对照" : "切换为仅译文");
    $("#display-mode-toggle").title = translation ? "仅译文 · 点击切换为双语对照" : "双语对照 · 点击切换为仅译文";
    document.querySelectorAll("[data-display-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.displayMode === settings.immersiveDisplayMode)));
  }
  function renderSite() {
    const rule = settings.immersiveSiteRules?.[hostname] || "inherit";
    document.querySelectorAll("[data-site-rule]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.siteRule === rule)));
  }
  function saveMode(mode) { return save({ immersiveDisplayMode: mode }); }
  async function save(values) {
    if (saving) return;
    saving = true;
    renderControls();
    try {
      await api((done) => chrome.storage.local.set(values, done));
      Object.assign(settings, values);
      status("设置已保存");
    } catch (error) { status(`保存失败：${error.message}`, true); }
    finally {
      $("#source-language").value = settings.immersiveSourceLanguage;
      $("#target-language").value = settings.immersiveTargetLanguage || settings.targetLanguage;
      $("#translation-service").value = settings.immersiveTranslationService;
      $("#subtitle-enabled-toggle").checked = settings.subtitleEnabled !== false;
      $("#auto-translate-toggle").checked = settings.immersiveAutoTranslate === true;
      renderMode();
      renderSite();
      saving = false;
      renderControls();
    }
  }
})();
