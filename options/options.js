(function runOptionsPage() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const form = document.querySelector("#settings-form");
  const settingsToggle = document.querySelector("#settings-toggle");
  const translationServiceSelect = document.querySelector("#translationServiceId");
  const translationModelSelect = document.querySelector("#translationModelId");
  const translationModelHint = document.querySelector("#translationModelHint");
  const realtimeServiceHint = document.querySelector("#realtime-service-hint");
  const translationJsonResponse = document.querySelector("#translationJsonResponse");
  const immersiveServiceSelect = document.querySelector("#immersiveTranslationServiceId");
  const immersiveModelSelect = document.querySelector("#immersiveTranslationModelId");
  const immersiveModelHint = document.querySelector("#immersiveTranslationModelHint");
  const immersiveTranslationJsonResponse = document.querySelector("#immersiveTranslationJsonResponse");
  const immersiveFallbackProvider = document.querySelector("#immersiveFallbackProvider");
  const immersiveGoogleApiKey = document.querySelector("#immersiveGoogleApiKey");
  const llmSentenceSegmentationEnabled = document.querySelector("#llmSentenceSegmentationEnabled");
  const asrCorrectionEnabled = document.querySelector("#asrCorrectionEnabled");
  const showOriginalTechnicalTerms = document.querySelector("#showOriginalTechnicalTerms");
  const sourceLanguage = document.querySelector("#sourceLanguage");
  const targetLanguage = document.querySelector("#targetLanguage");
  const fontScale = document.querySelector("#fontScale");
  const fontScaleValue = document.querySelector("#fontScaleValue");
  const subtitleEnabled = document.querySelector("#subtitleEnabled");
  const subtitleTranslationMode = document.querySelector("#subtitleTranslationMode");
  const subtitleLookAheadMinutes = document.querySelector("#subtitleLookAheadMinutes");
  const status = document.querySelector("#status");
  const clearCache = document.querySelector("#clear-cache");
  const serviceList = document.querySelector("#custom-service-list");
  const serviceEmpty = document.querySelector("#custom-service-empty");
  const dialog = document.querySelector("#service-dialog");
  const dialogTitle = document.querySelector("#service-dialog-title");
  const serviceName = document.querySelector("#service-name");
  const serviceBaseUrl = document.querySelector("#service-base-url");
  const serviceProtocol = document.querySelector("#service-protocol");
  const serviceApiKey = document.querySelector("#service-api-key");
  const serviceModels = document.querySelector("#service-models");
  const serviceModelsStatus = document.querySelector("#service-models-status");
  const addService = document.querySelector("#add-service");
  const addModelRow = document.querySelector("#add-model-row");
  const fetchModels = document.querySelector("#fetch-models");
  const cancelService = document.querySelector("#cancel-service");
  const saveService = document.querySelector("#save-service");

  // Each entry owns one sub-page; the hash keeps the current page shareable and reloadable.
  const SUB_PAGES = [
    { id: "translation-services", label: "翻译服务" },
    { id: "realtime-api", label: "实时字幕" },
    { id: "immersive-api", label: "沉浸式翻译" },
    { id: "general-settings", label: "通用设置" }
  ];
  const DEFAULT_SUB_PAGE = SUB_PAGES[0].id;

  const editor = {
    services: [],
    editingServiceId: "",
    opener: null,
    translationServiceId: "",
    translationModelId: "",
    immersiveTranslationServiceId: "",
    immersiveTranslationModelId: ""
  };

  let activateSubPage = () => {};

  init();

  async function init() {
    if (!form) {
      return;
    }

    activateSubPage = setupSubPageNavigation();

    const settings = await storageGet(Core.DEFAULT_SETTINGS);
    hydrateTranslationServices(settings);

    if (immersiveFallbackProvider && immersiveGoogleApiKey) {
      immersiveFallbackProvider.value = settings.immersiveFallbackProvider || "off";
      immersiveGoogleApiKey.value = settings.immersiveGoogleApiKey || "";
      const updateFallbackFields = () => {
        immersiveGoogleApiKey.closest("label").hidden = immersiveFallbackProvider.value !== "google-cloud";
      };
      updateFallbackFields();
      immersiveFallbackProvider.addEventListener("change", updateFallbackFields);
    }

    if (llmSentenceSegmentationEnabled) {
      llmSentenceSegmentationEnabled.checked = settings.llmSentenceSegmentationEnabled !== false;
    }
    if (asrCorrectionEnabled) {
      asrCorrectionEnabled.checked = settings.asrCorrectionEnabled !== false;
    }
    if (showOriginalTechnicalTerms) {
      showOriginalTechnicalTerms.checked = settings.showOriginalTechnicalTerms !== false;
    }
    if (sourceLanguage) {
      sourceLanguage.value = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    }
    if (targetLanguage) {
      targetLanguage.value = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    }
    if (fontScale) {
      fontScale.min = String(Core.FONT_SCALE_MIN);
      fontScale.max = String(Core.FONT_SCALE_MAX);
      fontScale.step = String(Core.FONT_SCALE_STEP);
      fontScale.value = Core.normalizeFontScale(settings.fontScale);
    }
    if (subtitleEnabled) {
      subtitleEnabled.checked = settings.subtitleEnabled !== false;
    }
    if (subtitleTranslationMode) subtitleTranslationMode.value = settings.subtitleTranslationMode === "full" ? "full" : "economy";
    if (subtitleLookAheadMinutes) subtitleLookAheadMinutes.value = String(settings.subtitleLookAheadMinutes || 2);

    updateFontScaleLabel();
    bindEvents();
  }

  // ── sub-page navigation ─────────────────────────────────────────────

  function setupSubPageNavigation() {
    const pages = [];
    for (const subPage of SUB_PAGES) {
      const tab = document.querySelector(`#tab-${subPage.id}`);
      const panel = document.querySelector(`#${subPage.id}`);
      if (tab && panel) {
        pages.push({ id: subPage.id, label: subPage.label, tab, panel });
      }
    }
    if (!pages.length) {
      return () => {};
    }

    const activate = (id, options = {}) => {
      const target = pages.find((page) => page.id === id) || pages[0];
      for (const page of pages) {
        const selected = page === target;
        // Hidden sub-pages keep their values, so one save button still stores every page.
        page.panel.hidden = !selected;
        page.tab.setAttribute("aria-selected", String(selected));
        page.tab.setAttribute("tabindex", selected ? "0" : "-1");
      }
      if (options.title !== false) {
        document.title = `${target.label} · AuraTranslate 设置`;
      }
      if (options.updateUrl) {
        writeSubPageHash(target.id);
      }
      if (options.focusTab) {
        target.tab.focus();
      }
      if (options.scroll) {
        scrollToLayoutTop();
      }
    };

    const moveFocus = (index) => {
      const next = pages[(index + pages.length) % pages.length];
      activate(next.id, { updateUrl: true, scroll: true, focusTab: true });
    };

    pages.forEach((page, index) => {
      page.tab.addEventListener("click", () => {
        activate(page.id, { updateUrl: true, scroll: true });
      });
      page.tab.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          moveFocus(index + 1);
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          moveFocus(index - 1);
        } else if (event.key === "Home") {
          moveFocus(0);
        } else if (event.key === "End") {
          moveFocus(pages.length - 1);
        } else {
          return;
        }
        event.preventDefault();
      });
    });

    if (typeof window !== "undefined" && window.addEventListener) {
      const followHistory = () => activate(currentSubPageId(), { updateUrl: false });
      window.addEventListener("hashchange", followHistory);
      window.addEventListener("popstate", followHistory);
    }

    activate(currentSubPageId(), { updateUrl: false });
    return (id) => activate(id, { updateUrl: true, scroll: true });
  }

  function currentSubPageId() {
    if (typeof window === "undefined" || !window.location) {
      return DEFAULT_SUB_PAGE;
    }
    const id = String(window.location.hash || "").replace(/^#\/?/, "");
    return SUB_PAGES.some((page) => page.id === id) ? id : DEFAULT_SUB_PAGE;
  }

  function writeSubPageHash(id) {
    if (typeof window === "undefined" || !window.history || !window.location) {
      return;
    }
    if (String(window.location.hash || "").replace(/^#/, "") === id) {
      return;
    }
    try {
      window.history.pushState(null, "", `#${id}`);
    } catch (error) {
      // Sandboxed documents cannot rewrite the URL; the sub-page switch still applies.
    }
  }

  function scrollToLayoutTop() {
    if (typeof window === "undefined" || typeof window.scrollTo !== "function") {
      return;
    }
    const layout = document.querySelector(".settings-layout");
    const top = layout && typeof layout.getBoundingClientRect === "function"
      ? Math.max(layout.getBoundingClientRect().top + (window.scrollY || 0) - 20, 0)
      : 0;
    window.scrollTo({ top, behavior: "smooth" });
  }

  // ── translation services ────────────────────────────────────────────

  function hydrateTranslationServices(settings) {
    const plan = Core.planTranslationServices(settings);
    editor.services = plan.services;
    editor.translationServiceId = plan.translationServiceId;
    editor.translationModelId = plan.translationModelId;
    editor.immersiveTranslationServiceId = plan.immersiveTranslationServiceId;
    editor.immersiveTranslationModelId = plan.immersiveTranslationModelId;
    if (translationJsonResponse) {
      translationJsonResponse.checked = settings.translationJsonResponse !== false;
    }
    if (immersiveTranslationJsonResponse) {
      immersiveTranslationJsonResponse.checked = settings.immersiveTranslationJsonResponse !== false;
    }
    renderServiceList();
    renderServiceOptions();
  }

  function serviceById(id) {
    return Core.findTranslationService(editor.services, id);
  }

  function renderServiceList() {
    if (!serviceList || typeof document.createElement !== "function") {
      return;
    }

    serviceList.textContent = "";
    for (const service of editor.services) {
      serviceList.appendChild(buildServiceCard(service));
    }
    if (serviceEmpty) {
      serviceEmpty.hidden = editor.services.length > 0;
    }
  }

  function buildServiceCard(service) {
    const card = document.createElement("article");
    card.className = "service-card";
    card.dataset.serviceId = service.id;

    const head = document.createElement("div");
    head.className = "service-card-head";
    const name = document.createElement("h4");
    name.className = "service-name";
    if (service.name) {
      name.textContent = service.name;
    } else {
      name.textContent = "未命名供应方";
      name.classList.add("is-unnamed");
    }
    head.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "service-actions";
    actions.appendChild(buildCardButton("编辑", "edit-service", service, ""));
    actions.appendChild(buildCardButton("删除", "delete-service", service, "danger"));
    head.appendChild(actions);
    card.appendChild(head);

    const description = document.createElement("p");
    description.className = "service-desc";
    const label = document.createElement("span");
    label.className = "service-desc-label";
    label.textContent = "描述";
    const value = document.createElement("span");
    value.textContent = Core.describeTranslationService(service);
    description.appendChild(label);
    description.appendChild(value);
    card.appendChild(description);

    if (service.models.length) {
      const models = document.createElement("ul");
      models.className = "service-models";
      for (const model of service.models) {
        const item = document.createElement("li");
        item.className = "service-model";
        item.textContent = model.id;
        if (model.displayName) {
          const displayName = document.createElement("span");
          displayName.textContent = ` ${model.displayName}`;
          item.appendChild(displayName);
        }
        models.appendChild(item);
      }
      card.appendChild(models);
    }
    return card;
  }

  function buildCardButton(text, action, service, extraClass) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = extraClass ? `ghost ${extraClass}` : "ghost";
    button.dataset.action = action;
    button.dataset.serviceId = service.id;
    button.textContent = text;
    if (action === "delete-service" && service.name) {
      button.setAttribute("aria-label", `删除 ${service.name}`);
    }
    return button;
  }

  function renderServiceOptions() {
    if (translationServiceSelect) {
      const options = editor.services.length
        ? editor.services.map((service) => ({ value: service.id, label: service.name || "未命名供应方" }))
        : [{ value: "", label: "尚未添加翻译服务" }];
      fillOptions(translationServiceSelect, options);
      translationServiceSelect.disabled = !editor.services.length;
      const stored = serviceById(editor.translationServiceId);
      translationServiceSelect.value = stored ? stored.id : (editor.services[0] ? editor.services[0].id : "");
      editor.translationServiceId = translationServiceSelect.value;
    }

    if (immersiveServiceSelect) {
      fillOptions(immersiveServiceSelect, [
        { value: "", label: "沿用实时字幕服务" },
        ...editor.services.map((service) => ({ value: service.id, label: service.name || "未命名供应方" }))
      ]);
      immersiveServiceSelect.disabled = !editor.services.length;
      const dedicated = serviceById(editor.immersiveTranslationServiceId);
      immersiveServiceSelect.value = dedicated ? dedicated.id : "";
      editor.immersiveTranslationServiceId = immersiveServiceSelect.value;
    }

    if (realtimeServiceHint) {
      realtimeServiceHint.hidden = editor.services.length > 0;
    }

    renderModelOptions();
  }

  function renderModelOptions() {
    const realtimeService = serviceById(editor.translationServiceId);
    const realtimeModels = realtimeService ? realtimeService.models : [];

    if (translationModelSelect) {
      fillOptions(
        translationModelSelect,
        realtimeModels.length
          ? realtimeModels.map((model) => ({ value: model.id, label: modelLabel(model) }))
          : [{ value: "", label: "暂无模型" }]
      );
      translationModelSelect.disabled = !realtimeModels.length;
      editor.translationModelId = realtimeModels.length
        ? Core.pickModelId(realtimeService, editor.translationModelId)
        : "";
      translationModelSelect.value = editor.translationModelId;
    }
    if (translationModelHint) {
      translationModelHint.textContent = realtimeModels.length
        ? `共 ${realtimeModels.length} 个模型，来自“翻译服务”页的模型目录。`
        : "请先在“翻译服务”页为这个供应方添加模型。";
    }

    const dedicatedService = serviceById(editor.immersiveTranslationServiceId);
    const immersiveTarget = dedicatedService || realtimeService;
    const immersiveModels = immersiveTarget ? immersiveTarget.models : [];

    if (immersiveModelSelect) {
      fillOptions(
        immersiveModelSelect,
        immersiveModels.length
          ? immersiveModels.map((model) => ({ value: model.id, label: modelLabel(model) }))
          : [{ value: "", label: "暂无模型" }]
      );
      if (dedicatedService) {
        editor.immersiveTranslationModelId = immersiveModels.length
          ? Core.pickModelId(dedicatedService, editor.immersiveTranslationModelId)
          : "";
        immersiveModelSelect.value = editor.immersiveTranslationModelId;
        immersiveModelSelect.disabled = !immersiveModels.length;
      } else {
        // Inheriting keeps the stored selection empty but shows what will be used.
        editor.immersiveTranslationModelId = "";
        immersiveModelSelect.value = realtimeModels.length
          ? Core.pickModelId(realtimeService, editor.translationModelId)
          : "";
        immersiveModelSelect.disabled = true;
      }
    }
    if (immersiveModelHint) {
      if (!immersiveModels.length) {
        immersiveModelHint.textContent = "请先在“翻译服务”页为这个供应方添加模型。";
      } else if (dedicatedService) {
        immersiveModelHint.textContent = `来自 ${dedicatedService.name || "所选供应方"} 的模型目录。`;
      } else {
        immersiveModelHint.textContent = `沿用实时字幕模型（${immersiveModels.length} 个可选）。`;
      }
    }
  }

  function modelLabel(model) {
    return model.displayName ? `${model.id} · ${model.displayName}` : model.id;
  }

  function fillOptions(select, options) {
    if (!select || typeof document.createElement !== "function") {
      return;
    }
    select.textContent = "";
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
  }

  function openServiceDialog(serviceId) {
    if (!dialog) {
      return;
    }

    const service = serviceId ? serviceById(serviceId) : null;
    editor.editingServiceId = service ? service.id : "";
    editor.opener = document.activeElement || null;

    if (dialogTitle) {
      dialogTitle.textContent = service ? "编辑自定义供应方" : "添加自定义供应方";
    }
    if (serviceName) serviceName.value = service ? service.name : "";
    if (serviceBaseUrl) serviceBaseUrl.value = service ? service.baseUrl : "";
    if (serviceApiKey) serviceApiKey.value = service ? service.apiKey : "";
    if (serviceProtocol) {
      fillOptions(serviceProtocol, protocolOptions());
      serviceProtocol.value = service ? service.apiProtocol : "openai-compatible";
    }
    if (serviceModels) {
      serviceModels.textContent = "";
      const models = service && service.models.length ? service.models : [{ id: "", displayName: "" }];
      for (const model of models) {
        appendModelRow(model);
      }
    }
    setModelStatus("");
    dialog.hidden = false;
    if (serviceName && typeof serviceName.focus === "function") {
      serviceName.focus();
    }
  }

  function closeServiceDialog() {
    if (dialog) {
      dialog.hidden = true;
    }
    editor.editingServiceId = "";
    setModelStatus("");
    if (editor.opener && typeof editor.opener.focus === "function") {
      editor.opener.focus();
    }
    editor.opener = null;
  }

  function protocolOptions() {
    const protocols = Core.TRANSLATION_SERVICE_PROTOCOLS || {};
    return Object.keys(protocols).map((key) => ({ value: key, label: key }));
  }

  function appendModelRow(model) {
    if (!serviceModels || typeof document.createElement !== "function") {
      return;
    }

    const row = document.createElement("div");
    row.className = "model-row";
    row.appendChild(modelInput("model-id", model && model.id, "模型 id，例如 gpt-6-astra"));
    row.appendChild(modelInput("model-display-name", model && model.displayName, "显示名称（可选）"));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.dataset.action = "remove-model";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "删除模型");
    row.appendChild(remove);

    serviceModels.appendChild(row);
  }

  function modelInput(className, value, placeholder) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = className;
    input.value = value || "";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", className === "model-id" ? "模型 id" : "显示名称");
    return input;
  }

  function collectModelRows() {
    const models = [];
    for (const row of queryAll(".model-row", serviceModels)) {
      const id = row.querySelector(".model-id");
      const displayName = row.querySelector(".model-display-name");
      const value = String((id && id.value) || "").trim();
      if (!value) continue;
      models.push({ id: value, displayName: String((displayName && displayName.value) || "").trim() });
    }
    return models;
  }

  function saveServiceDraft() {
    const draft = {
      id: editor.editingServiceId || nextServiceId(),
      name: String((serviceName && serviceName.value) || "").trim(),
      apiProtocol: String((serviceProtocol && serviceProtocol.value) || "openai-compatible"),
      baseUrl: String((serviceBaseUrl && serviceBaseUrl.value) || "").trim(),
      apiKey: String((serviceApiKey && serviceApiKey.value) || "").trim(),
      models: collectModelRows()
    };

    if (!draft.name) {
      setModelStatus("请填写供应方名称。");
      return;
    }

    const index = editor.services.findIndex((service) => service.id === draft.id);
    if (index >= 0) {
      editor.services[index] = draft;
    } else {
      editor.services.push(draft);
    }
    if (!editor.translationServiceId) {
      editor.translationServiceId = draft.id;
    }

    renderServiceList();
    renderServiceOptions();
    closeServiceDialog();
  }

  function deleteService(serviceId) {
    const index = editor.services.findIndex((service) => service.id === serviceId);
    if (index < 0) {
      return;
    }

    editor.services.splice(index, 1);
    if (editor.translationServiceId === serviceId) {
      editor.translationServiceId = editor.services.length ? editor.services[0].id : "";
      editor.translationModelId = "";
    }
    if (editor.immersiveTranslationServiceId === serviceId) {
      editor.immersiveTranslationServiceId = "";
      editor.immersiveTranslationModelId = "";
    }
    renderServiceList();
    renderServiceOptions();
  }

  function nextServiceId() {
    let highest = 0;
    for (const service of editor.services) {
      const match = /^service-(\d+)$/.exec(service.id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return `service-${highest + 1}`;
  }

  async function fetchServiceModels() {
    const baseUrl = String((serviceBaseUrl && serviceBaseUrl.value) || "").trim();
    if (!baseUrl) {
      setModelStatus("请先填写 API 地址。");
      return;
    }
    if (typeof fetch !== "function") {
      return;
    }

    const url = Core.buildModelsUrl(baseUrl);
    setModelStatus("正在获取可用模型…");
    if (fetchModels) fetchModels.disabled = true;
    try {
      const apiKey = String((serviceApiKey && serviceApiKey.value) || "").trim();
      const response = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const modelIds = extractModelIds(await response.json());
      if (!modelIds.length) {
        setModelStatus("接口没有返回可用的模型，请手工填写模型 id。");
        return;
      }

      const models = collectModelRows();
      const known = new Set(models.map((model) => model.id));
      let added = 0;
      for (const id of modelIds) {
        if (known.has(id)) continue;
        models.push({ id, displayName: "" });
        known.add(id);
        added += 1;
      }
      if (serviceModels) {
        serviceModels.textContent = "";
        for (const model of models) {
          appendModelRow(model);
        }
      }
      setModelStatus(`接口返回 ${modelIds.length} 个模型，新增 ${added} 个。`);
    } catch (error) {
      const reason = error && error.message ? error.message : "请求失败";
      setModelStatus(`获取失败（${reason}），请确认 API 地址与密钥，或手工填写模型 id。`);
    } finally {
      if (fetchModels) fetchModels.disabled = false;
    }
  }

  function extractModelIds(payload) {
    const list = payload && Array.isArray(payload.data)
      ? payload.data
      : payload && Array.isArray(payload.models)
        ? payload.models
        : [];
    const ids = [];
    for (const entry of list) {
      const id = String((entry && (entry.id || entry.name)) || "").trim().replace(/^models\//, "");
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  function setModelStatus(message) {
    if (serviceModelsStatus) {
      serviceModelsStatus.textContent = message;
    }
  }

  function queryAll(selector, root) {
    const scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== "function") {
      return [];
    }
    return Array.from(scope.querySelectorAll(selector));
  }

  // ── events ──────────────────────────────────────────────────────────

  function bindEvents() {
    if (settingsToggle) {
      settingsToggle.addEventListener("click", toggleSettingsPanel);
    }
    if (fontScale) {
      fontScale.addEventListener("input", updateFontScaleLabel);
    }
    form.addEventListener("submit", saveSettings);
    if (clearCache) {
      clearCache.addEventListener("click", clearTranslationCache);
    }

    if (addService) {
      addService.addEventListener("click", () => openServiceDialog(""));
    }
    if (serviceList) {
      serviceList.addEventListener("click", (event) => {
        const button = closest(event.target, "[data-action]");
        if (!button) return;
        if (button.dataset.action === "edit-service") {
          openServiceDialog(button.dataset.serviceId);
        } else if (button.dataset.action === "delete-service") {
          deleteService(button.dataset.serviceId);
        }
      });
    }
    if (serviceModels) {
      serviceModels.addEventListener("click", (event) => {
        const button = closest(event.target, '[data-action="remove-model"]');
        if (!button) return;
        const row = closest(button, ".model-row");
        if (row && row.parentNode) {
          row.parentNode.removeChild(row);
        }
      });
    }
    if (addModelRow) {
      addModelRow.addEventListener("click", () => appendModelRow({ id: "", displayName: "" }));
    }
    if (fetchModels) {
      fetchModels.addEventListener("click", fetchServiceModels);
    }
    if (cancelService) {
      cancelService.addEventListener("click", closeServiceDialog);
    }
    if (saveService) {
      saveService.addEventListener("click", saveServiceDraft);
    }
    if (dialog) {
      dialog.addEventListener("click", (event) => {
        const target = closest(event.target, "[data-close]");
        if (target) closeServiceDialog();
      });
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeServiceDialog();
        }
      });
    }

    if (translationServiceSelect) {
      translationServiceSelect.addEventListener("change", () => {
        editor.translationServiceId = translationServiceSelect.value;
        editor.translationModelId = "";
        renderModelOptions();
      });
    }
    if (translationModelSelect) {
      translationModelSelect.addEventListener("change", () => {
        editor.translationModelId = translationModelSelect.value;
      });
    }
    if (immersiveServiceSelect) {
      immersiveServiceSelect.addEventListener("change", () => {
        editor.immersiveTranslationServiceId = immersiveServiceSelect.value;
        editor.immersiveTranslationModelId = "";
        renderModelOptions();
      });
    }
    if (immersiveModelSelect) {
      immersiveModelSelect.addEventListener("change", () => {
        editor.immersiveTranslationModelId = immersiveModelSelect.value;
      });
    }

    for (const button of queryAll("[data-goto]")) {
      button.addEventListener("click", () => activateSubPage(button.dataset.goto));
    }
  }

  function closest(element, selector) {
    return element && typeof element.closest === "function" ? element.closest(selector) : null;
  }

  // ── persistence ─────────────────────────────────────────────────────

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  async function saveSettings(event) {
    event.preventDefault();

    const realtimeService = serviceById(editor.translationServiceId);
    const immersiveService = serviceById(editor.immersiveTranslationServiceId);
    const dedicatedImmersive = Boolean(immersiveService);
    const translationModelId = realtimeService ? Core.pickModelId(realtimeService, editor.translationModelId) : "";
    const immersiveModelId = dedicatedImmersive ? Core.pickModelId(immersiveService, editor.immersiveTranslationModelId) : "";

    await storageSet({
      translationServices: editor.services,
      translationServiceId: realtimeService ? realtimeService.id : "",
      translationModelId,
      immersiveTranslationServiceId: dedicatedImmersive ? immersiveService.id : "",
      immersiveTranslationModelId: dedicatedImmersive ? immersiveModelId : "",
      // The legacy keys mirror the effective choice so older versions and
      // rollbacks keep reading the same credentials.
      translationProvider: "custom",
      translationApiKey: realtimeService ? realtimeService.apiKey : "",
      translationBaseUrl: realtimeService ? realtimeService.baseUrl : "",
      translationModel: translationModelId,
      translationJsonResponse: readChecked(translationJsonResponse, true),
      immersiveTranslationProvider: dedicatedImmersive ? "custom" : "",
      immersiveTranslationApiKey: dedicatedImmersive ? immersiveService.apiKey : "",
      immersiveTranslationBaseUrl: dedicatedImmersive ? immersiveService.baseUrl : "",
      immersiveTranslationModel: dedicatedImmersive ? immersiveModelId : "",
      immersiveTranslationJsonResponse: dedicatedImmersive ? readChecked(immersiveTranslationJsonResponse, true) : true,
      immersiveFallbackProvider: readValue(immersiveFallbackProvider, "off"),
      immersiveGoogleApiKey: readValue(immersiveGoogleApiKey, "").trim(),
      llmSentenceSegmentationEnabled: readChecked(llmSentenceSegmentationEnabled, true),
      asrCorrectionEnabled: readChecked(asrCorrectionEnabled, true),
      showOriginalTechnicalTerms: readChecked(showOriginalTechnicalTerms, true),
      sourceLanguage: readValue(sourceLanguage, Core.DEFAULT_SETTINGS.sourceLanguage),
      targetLanguage: readValue(targetLanguage, Core.DEFAULT_SETTINGS.targetLanguage),
      fontScale: Core.normalizeFontScale(readValue(fontScale, Core.DEFAULT_SETTINGS.fontScale)),
      subtitleEnabled: readChecked(subtitleEnabled, true),
      subtitleTranslationMode: readValue(subtitleTranslationMode, "economy") === "full" ? "full" : "economy",
      subtitleLookAheadMinutes: Number(readValue(subtitleLookAheadMinutes, "2"))
    });
    await storageRemove("deepseekApiKey");
    showStatus("设置已保存。");
  }

  function readValue(element, fallback) {
    return element ? element.value : fallback;
  }

  function readChecked(element, fallback) {
    return element ? element.checked : fallback;
  }

  async function clearTranslationCache() {
    const all = await storageGet(null);
    const cacheKeys = Object.keys(all).filter((key) => key.startsWith("ytbt:"));
    if (cacheKeys.length) {
      await storageRemove(cacheKeys);
    }
    await storageSet({ cacheVersion: String(Date.now()) });
    showStatus(`已清空 ${cacheKeys.length} 组翻译缓存。`);
  }

  function updateFontScaleLabel() {
    if (fontScaleValue && fontScale) {
      fontScaleValue.textContent = `${Core.normalizeFontScale(fontScale.value).toFixed(2)}x`;
    }
  }

  function toggleSettingsPanel() {
    form.hidden = !form.hidden;
    settingsToggle.setAttribute("aria-expanded", String(!form.hidden));
    settingsToggle.textContent = form.hidden ? "设置" : "收起设置";
  }

  function showStatus(message) {
    if (!status) {
      return;
    }

    status.textContent = message;
    setTimeout(() => {
      if (status.textContent === message) {
        status.textContent = "";
      }
    }, 2400);
  }
})();