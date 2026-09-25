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
  const detail = document.querySelector("#service-detail");
  const detailApiKey = document.querySelector("#detail-api-key");
  const detailBaseUrl = document.querySelector("#detail-base-url");
  const detailFetchModels = document.querySelector("#detail-fetch-models");
  const detailTestModels = document.querySelector("#detail-test-models");
  const modelTestDialog = document.querySelector("#model-test-dialog");
  const startModelTest = document.querySelector("#start-model-test");
  const modelTestResults = document.querySelector("#model-test-results");
  const modelPickerDialog = document.querySelector("#model-picker-dialog");
  const modelPickerList = document.querySelector("#model-picker-list");
  const modelPickerSummary = document.querySelector("#model-picker-summary");
  const modelPickerSelectedCount = document.querySelector("#model-picker-selected-count");
  const modelPickerAdd = document.querySelector("#model-picker-add");
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
  const MODEL_TEST_CONCURRENCY = 3;

  const editor = {
    services: [],
    selectedServiceId: "",
    dialogVersion: 0,
    detailRequest: null,
    modelTestVersion: 0,
    modelTestControllers: new Set(),
    modelTestContext: null,
    modelPickerContext: null,
    modelPickerOpener: null,
    editingServiceId: "",
    opener: null,
    translationServiceId: "",
    translationModelId: "",
    immersiveTranslationServiceId: "",
    immersiveTranslationModelId: ""
  };

  let saveTimer = null;
  let saveQueue = Promise.resolve();

  let activateSubPage = () => {};

  init();

  async function init() {
    if (!form) {
      return;
    }

    activateSubPage = setupSubPageNavigation();

    const settings = await storageGet(Core.DEFAULT_SETTINGS);
    hydrateTranslationServices(settings);
    await storageRemove(["immersiveFallbackProvider", "immersiveGoogleApiKey"]);

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
    renderServiceOptions();
    renderServiceList();
  }

  function serviceById(id) {
    return Core.findTranslationService(editor.services, id);
  }

  function renderServiceList() {
    if (!serviceList || typeof document.createElement !== "function") {
      return;
    }

    if (!serviceById(editor.selectedServiceId)) {
      editor.selectedServiceId = editor.translationServiceId || editor.services[0]?.id || "";
    }
    const scroll = document.querySelector(".services-scroll");
    const scrollTop = scroll.scrollTop;
    const focusedId = document.activeElement?.dataset.selectService;
    serviceList.textContent = "";
    let otherCount = 0;
    for (const service of editor.services) {
      const labels = [];
      if (service.id === editor.translationServiceId) labels.push("默认");
      if (service.id === editor.immersiveTranslationServiceId) labels.push("网页默认");
      serviceList.appendChild(buildServiceEntry(service.id, service.name || "未命名供应方", labels.join(" · ") || `${service.models.length} 个模型`));
      otherCount += 1;
    }
    if (serviceEmpty) {
      serviceEmpty.hidden = otherCount > 0;
    }
    scroll.scrollTop = scrollTop;
    if (focusedId) {
      queryAll("[data-select-service]").find((button) => button.dataset.selectService === focusedId)?.focus({ preventScroll: true });
    }
    renderServiceDetail();
  }

  function buildServiceEntry(id, name, subtitle) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "service-entry";
    button.dataset.selectService = id;
    button.setAttribute("aria-controls", "service-detail");
    button.setAttribute("aria-current", String(editor.selectedServiceId === id));
    const title = document.createElement("span");
    title.className = "service-entry-name";
    title.textContent = name;
    const hint = document.createElement("span");
    hint.className = "service-entry-hint";
    hint.textContent = subtitle;
    button.append(title, hint);
    return button;
  }

  function renderServiceDetail() {
    const service = serviceById(editor.selectedServiceId);
    detail.hidden = !service;
    if (detail.dataset.serviceId !== editor.selectedServiceId) detail.scrollTop = 0;
    detail.dataset.serviceId = editor.selectedServiceId;
    document.querySelector("#detail-name").textContent = service ? service.name || "未命名供应方" : "";
    document.querySelector("#detail-kind").textContent = service ? "自定义供应方" : "";
    document.querySelector("#detail-actions").hidden = !service;
    document.querySelector("#detail-connection").hidden = !service;
    document.querySelector("#detail-model-catalog").hidden = !service;
    document.querySelector("#detail-description").textContent = service
      ? "在此修改密钥和 API 地址；点击编辑维护名称与模型目录。"
      : "";
    detailApiKey.value = service ? service.apiKey : "";
    detailBaseUrl.value = service ? service.baseUrl : "";
    document.querySelector("#detail-protocol").value = service ? service.apiProtocol : "";
    detailFetchModels.hidden = !service;
    detailFetchModels.disabled = !!editor.detailRequest;
    if (detailTestModels) {
      detailTestModels.hidden = !service;
      detailTestModels.disabled = editor.modelTestControllers.size > 0;
    }
    document.querySelector("#detail-add-model").hidden = !service;
    renderDetailModels(service);
    document.querySelector("#detail-model-status").textContent = "";
  }

  function renderDetailModels(service) {
    const list = document.querySelector("#detail-models");
    list.textContent = "";
    document.querySelector("#detail-model-count").textContent = service ? `(${service.models.length})` : "";
    for (const model of service?.models || []) {
      const item = document.createElement("li");
      item.className = "detail-model-row";
      const id = document.createElement("input");
      id.type = "text";
      id.className = "detail-model-id";
      id.value = model.id;
      id.placeholder = "模型 id，例如 gpt-6-astra";
      id.setAttribute("aria-label", "模型 id");
      const name = document.createElement("input");
      name.type = "text";
      name.className = "detail-model-display-name";
      name.value = model.displayName;
      name.placeholder = "显示名称（可选）";
      name.setAttribute("aria-label", "模型显示名称");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button";
      remove.dataset.action = "remove-detail-model";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `删除模型 ${model.id || ""}`);
      item.append(id, name, remove);
      list.appendChild(item);
    }
    if (service && !list.children.length) {
      const empty = document.createElement("li");
      empty.className = "model-empty";
      empty.textContent = "暂无模型，可添加模型或获取模型列表。";
      list.appendChild(empty);
    }
  }

  function addDetailModel() {
    const service = serviceById(editor.selectedServiceId);
    if (!service) return;
    service.models.push({ id: "", displayName: "" });
    renderDetailModels(service);
    renderServiceOptions();
    renderServiceList();
    document.querySelector("#detail-models .detail-model-row:last-child .detail-model-id")?.focus();
    saveSettings();
  }

  function updateDetailModel(event) {
    const service = serviceById(editor.selectedServiceId);
    const input = closest(event.target, ".detail-model-id, .detail-model-display-name");
    if (!service || !input) return;
    const row = closest(input, ".detail-model-row");
    const index = Array.prototype.indexOf.call(row.parentElement.children, row);
    const model = service.models[index];
    if (!model) return;
    const oldId = model.id;
    if (input.classList.contains("detail-model-id")) {
      model.id = input.value.trim();
      row.querySelector('[data-action="remove-detail-model"]')
        .setAttribute("aria-label", `删除模型 ${model.id || ""}`);
      if (oldId !== model.id) {
        if (editor.translationModelId === oldId) editor.translationModelId = "";
        if (editor.immersiveTranslationModelId === oldId) editor.immersiveTranslationModelId = "";
        renderServiceOptions();
        const entry = queryAll("[data-select-service]").find((button) => button.dataset.selectService === service.id);
        if (entry) entry.querySelector(".service-entry-hint").textContent =
          `${service.id === editor.translationServiceId ? "默认 · " : ""}${service.id === editor.immersiveTranslationServiceId ? "网页默认 · " : ""}${service.models.length} 个模型`;
      }
    } else {
      model.displayName = input.value.trim();
    }
  }

  function removeDetailModel(button) {
    const service = serviceById(editor.selectedServiceId);
    const row = closest(button, ".detail-model-row");
    if (!service || !row) return;
    const index = Array.prototype.indexOf.call(row.parentElement.children, row);
    const [removed] = service.models.splice(index, 1);
    if (removed?.id === editor.translationModelId) editor.translationModelId = "";
    if (removed?.id === editor.immersiveTranslationModelId) editor.immersiveTranslationModelId = "";
    renderServiceOptions();
    renderServiceList();
    saveSettings();
  }

  function renderServiceOptions() {
    if (translationServiceSelect) {
      const options = editor.services.length
        ? [
          { value: "", label: "选择默认服务" },
          ...editor.services.map((service) => ({ value: service.id, label: service.name || "未命名供应方" }))
        ]
        : [{ value: "", label: "尚未添加翻译服务" }];
      fillOptions(translationServiceSelect, options);
      translationServiceSelect.disabled = !editor.services.length;
      const stored = serviceById(editor.translationServiceId);
      translationServiceSelect.value = stored ? stored.id : "";
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
      realtimeServiceHint.hidden = Boolean(editor.translationServiceId);
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
    editor.dialogVersion += 1;
    fetchModels.disabled = false;
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
    form.inert = true;
    document.querySelector(".settings-sidebar").inert = true;
    if (serviceName && typeof serviceName.focus === "function") {
      serviceName.focus();
    }
  }

  function closeServiceDialog() {
    editor.dialogVersion += 1;
    form.inert = false;
    document.querySelector(".settings-sidebar").inert = false;
    if (dialog) {
      dialog.hidden = true;
    }
    editor.editingServiceId = "";
    setModelStatus("");
    if (editor.opener?.isConnected && typeof editor.opener.focus === "function") {
      editor.opener.focus();
    } else {
      document.querySelector("#edit-service").focus();
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
    editor.selectedServiceId = draft.id;
    renderServiceOptions();
    renderServiceList();
    closeServiceDialog();
    saveSettings();
  }

  function deleteService(serviceId) {
    const index = editor.services.findIndex((service) => service.id === serviceId);
    if (index < 0) {
      return;
    }

    editor.services.splice(index, 1);
    if (editor.translationServiceId === serviceId) {
      editor.translationServiceId = "";
      editor.translationModelId = "";
    }
    if (editor.immersiveTranslationServiceId === serviceId) {
      editor.immersiveTranslationServiceId = "";
      editor.immersiveTranslationModelId = "";
    }
    renderServiceOptions();
    renderServiceList();
    queryAll("[data-select-service]").find((button) => button.dataset.selectService === editor.selectedServiceId)?.focus();
    saveSettings();
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
    const version = editor.dialogVersion;
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
      if (version !== editor.dialogVersion || baseUrl !== serviceBaseUrl.value.trim() || apiKey !== serviceApiKey.value.trim()) return;
      if (!modelIds.length) {
        setModelStatus("接口没有返回可用的模型，请手工填写模型 id。");
        return;
      }
      openModelPicker(modelIds, new Set(collectModelRows().map((model) => model.id)), {
        source: "draft",
        dialogVersion: version,
        serviceId: editor.editingServiceId
      });
      setModelStatus(`接口返回 ${modelIds.length} 个模型，请在弹窗中勾选要添加的模型。`);
    } catch (error) {
      if (version !== editor.dialogVersion) return;
      const reason = error && error.message ? error.message : "请求失败";
      setModelStatus(`获取失败（${reason}），请确认 API 地址与密钥，或手工填写模型 id。`);
    } finally {
      if (version === editor.dialogVersion && fetchModels) fetchModels.disabled = false;
    }
  }

  async function fetchDetailModels() {
    const service = serviceById(editor.selectedServiceId);
    if (!service || editor.detailRequest) return;
    const message = document.querySelector("#detail-model-status");
    if (!service.baseUrl.trim()) {
      message.textContent = "请先填写 API 地址。";
      return;
    }
    const baseUrl = service.baseUrl;
    const apiKey = service.apiKey;
    const controller = new AbortController();
    editor.detailRequest = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    detailFetchModels.disabled = true;
    message.textContent = "正在获取可用模型…";
    const isCurrent = () => serviceById(service.id) === service && editor.selectedServiceId === service.id
      && service.baseUrl === baseUrl && service.apiKey === apiKey && dialog.hidden && modelTestDialog.hidden;
    try {
      const response = await fetch(Core.buildModelsUrl(baseUrl), {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const ids = extractModelIds(await response.json());
      if (!isCurrent()) return;
      if (!ids.length) {
        message.textContent = "接口没有返回可用模型，请点击编辑手动添加。";
        return;
      }
      openModelPicker(ids, new Set(service.models.map((model) => model.id)), {
        source: "detail",
        serviceId: service.id
      });
      message.textContent = `接口返回 ${ids.length} 个模型，请在弹窗中勾选要添加的模型。`;
    } catch (error) {
      if (isCurrent()) message.textContent = `获取失败（${error.name === "AbortError" ? "请求超时" : error.message}），已保留现有模型。`;
    } finally {
      clearTimeout(timer);
      editor.detailRequest = null;
      detailFetchModels.disabled = false;
    }
  }

  function modelTestStorageKey(context, modelId) {
    return "modelTestResult:" + JSON.stringify([context.serviceId, context.baseUrl, modelId]);
  }

  function renderModelTestResult(item, record) {
    const result = item.querySelector(".model-test-result-status");
    item.dataset.state = record?.state || "untested";
    item.dataset.latency = !record ? "unknown" : record.state === "error" || record.latencyMs > 10000
      ? "slow" : record.latencyMs > 3000 ? "medium" : "fast";
    result.textContent = record
      ? (record.state === "error" ? record.message + " · " : "") + record.latencyMs + " ms"
      : "未测试";
    result.title = record
      ? "上次测试：" + new Date(record.testedAt).toLocaleString() + "；完整响应耗时 " + record.latencyMs + " ms"
      : "尚无测试记录";
  }

  async function openModelTestDialog() {
    const service = serviceById(editor.selectedServiceId);
    if (!service || !modelTestDialog || !modelTestDialog.hidden) return;
    const version = ++editor.modelTestVersion;
    const context = {
      serviceId: service.id,
      baseUrl: service.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: service.apiKey.trim(),
      models: service.models.filter((model, index, models) => model.id.trim() && models.findIndex((entry) => entry.id === model.id) === index)
        .map((model) => ({ ...model })),
      running: false
    };
    editor.modelTestContext = context;
    modelTestDialog.hidden = false;
    form.inert = true;
    document.querySelector(".settings-sidebar").inert = true;
    modelTestResults.textContent = "";
    startModelTest.disabled = true;
    startModelTest.textContent = "测试";
    document.querySelector("#close-model-test").focus();
    const defaults = {};
    for (const model of context.models) {
      const item = document.createElement("li");
      item.className = "model-test-result";
      const name = document.createElement("span");
      name.className = "model-test-result-name";
      name.textContent = model.displayName ? model.displayName + "（" + model.id + "）" : model.id;
      const phase = document.createElement("span");
      phase.className = "model-test-result-phase";
      const result = document.createElement("span");
      result.className = "model-test-result-status";
      item.append(name, phase, result);
      renderModelTestResult(item, null);
      modelTestResults.appendChild(item);
      defaults[modelTestStorageKey(context, model.id)] = null;
    }
    if (!context.models.length) {
      const empty = document.createElement("li");
      empty.className = "model-empty";
      empty.textContent = "当前供应方没有可测试的模型。";
      modelTestResults.appendChild(empty);
    }
    startModelTest.title = context.baseUrl ? "测试全部模型" : "请先填写 API 地址";
    const saved = await storageGet(defaults);
    if (version !== editor.modelTestVersion) return;
    context.models.forEach((model, index) => {
      const record = saved[modelTestStorageKey(context, model.id)];
      if (!record || !["success", "error"].includes(record.state) ||
          !Number.isFinite(record.latencyMs) || record.latencyMs < 0) return;
      renderModelTestResult(modelTestResults.children[index], record);
    });
    startModelTest.disabled = !context.models.length || !context.baseUrl;
  }

  async function runModelTests() {
    const context = editor.modelTestContext;
    if (!context || context.running || startModelTest.disabled || modelTestDialog.hidden) return;
    const version = ++editor.modelTestVersion;
    context.running = true;
    startModelTest.disabled = true;
    startModelTest.textContent = "测试中…";
    modelTestResults.setAttribute("aria-busy", "true");
    for (const item of modelTestResults.children) {
      item.querySelector(".model-test-result-phase").textContent = "等待测试";
    }
    let nextIndex = 0;
    const worker = async () => {
      while (version === editor.modelTestVersion) {
        const index = nextIndex++;
        if (index >= context.models.length) return;
        const model = context.models[index];
        const item = modelTestResults.children[index];
        const phase = item.querySelector(".model-test-result-phase");
        phase.textContent = "测试中…";
        const controller = new AbortController();
        editor.modelTestControllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 20000);
        const started = performance.now();
        let record;
        try {
          const response = await fetch(Core.buildChatCompletionsUrl(context.baseUrl), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(context.apiKey ? { Authorization: "Bearer " + context.apiKey } : {})
            },
            body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Reply with OK." }] }),
            signal: controller.signal
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          let payload;
          try { payload = await response.json(); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            throw new Error("返回非 JSON 数据");
          }
          if (payload?.error) throw new Error("接口返回错误");
          const content = payload?.choices?.[0]?.message?.content;
          if (!(typeof content === "string" && content.trim()) &&
              !(Array.isArray(content) && content.some((part) => typeof part?.text === "string" && part.text.trim()))) {
            throw new Error("未返回有效回复");
          }
          record = { state: "success", message: "" };
        } catch (error) {
          record = { state: "error", message: controller.signal.aborted ? "请求超时"
            : error instanceof TypeError ? "网络请求失败" : String(error.message || "请求失败").slice(0, 50) };
        } finally {
          clearTimeout(timer);
          editor.modelTestControllers.delete(controller);
        }
        // Closing and reopening must not accept a late response from the old run.
        if (version !== editor.modelTestVersion) return;
        record.latencyMs = Math.max(1, Math.round(performance.now() - started));
        record.testedAt = Date.now();
        phase.textContent = "";
        renderModelTestResult(item, record);
        await storageSet({ [modelTestStorageKey(context, model.id)]: record });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MODEL_TEST_CONCURRENCY, context.models.length) }, worker));
    if (version !== editor.modelTestVersion) return;
    context.running = false;
    startModelTest.disabled = false;
    startModelTest.textContent = "测试";
    modelTestResults.setAttribute("aria-busy", "false");
  }

  function closeModelTestDialog() {
    editor.modelTestVersion += 1;
    for (const controller of editor.modelTestControllers) controller.abort();
    editor.modelTestControllers.clear();
    editor.modelTestContext = null;
    detailTestModels.disabled = false;
    modelTestDialog.hidden = true;
    modelTestResults.setAttribute("aria-busy", "false");
    form.inert = false;
    document.querySelector(".settings-sidebar").inert = false;
    detailTestModels.focus();
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

  function openModelPicker(modelIds, existingIds, context) {
    if (!modelPickerDialog || !modelPickerList) return;
    editor.modelPickerContext = context;
    editor.modelPickerOpener = document.activeElement;
    modelPickerList.textContent = "";
    let existingCount = 0;
    for (const id of modelIds) {
      const exists = existingIds.has(id);
      if (exists) existingCount += 1;
      const item = document.createElement("li");
      item.className = "model-picker-item";
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = id;
      checkbox.disabled = exists;
      const name = document.createElement("span");
      name.className = "model-picker-item-name";
      name.textContent = id;
      label.append(checkbox, name);
      item.appendChild(label);
      if (exists) {
        const state = document.createElement("small");
        state.textContent = "已在目录中";
        item.appendChild(state);
      }
      modelPickerList.appendChild(item);
    }
    modelPickerSummary.textContent = `接口返回 ${modelIds.length} 个模型，其中 ${existingCount} 个已在目录中。`;
    updateModelPickerSelection();

    form.inert = true;
    document.querySelector(".settings-sidebar").inert = true;
    if (!dialog.hidden) dialog.querySelector(".modal-panel").inert = true;
    modelPickerDialog.hidden = false;
    document.querySelector("#model-picker-select-all")?.focus();
  }

  function updateModelPickerSelection() {
    const selected = queryAll("input[type='checkbox']:checked:not(:disabled)", modelPickerList).length;
    modelPickerSelectedCount.textContent = `已选 ${selected} 个模型`;
    modelPickerAdd.disabled = selected === 0;
  }

  function selectAllNewModels(checked) {
    for (const checkbox of queryAll("input[type='checkbox']:not(:disabled)", modelPickerList)) {
      checkbox.checked = checked;
    }
    updateModelPickerSelection();
  }

  function applyModelPickerSelection() {
    const context = editor.modelPickerContext;
    const selectedIds = queryAll("input[type='checkbox']:checked:not(:disabled)", modelPickerList)
      .map((checkbox) => checkbox.value);
    if (!context || !selectedIds.length) return;

    if (context.source === "draft") {
      if (context.dialogVersion !== editor.dialogVersion || context.serviceId !== editor.editingServiceId) {
        closeModelPicker();
        return;
      }
      const models = collectModelRows();
      const known = new Set(models.map((model) => model.id));
      const added = selectedIds.filter((id) => !known.has(id)).map((id) => ({ id, displayName: "" }));
      for (const model of added) models.push(model);
      serviceModels.textContent = "";
      for (const model of models) appendModelRow(model);
      setModelStatus(`已添加 ${added.length} 个模型。`);
    } else if (context.source === "detail") {
      const service = serviceById(context.serviceId);
      if (!service || editor.selectedServiceId !== context.serviceId) {
        closeModelPicker();
        return;
      }
      const known = new Set(service.models.map((model) => model.id));
      const added = selectedIds.filter((id) => !known.has(id)).map((id) => ({ id, displayName: "" }));
      service.models.push(...added);
      renderServiceOptions();
      renderServiceList();
      document.querySelector("#detail-model-status").textContent = `已添加 ${added.length} 个模型。`;
      if (added.length) saveSettings();
    }

    closeModelPicker();
  }

  function closeModelPicker() {
    if (modelPickerDialog) modelPickerDialog.hidden = true;
    editor.modelPickerContext = null;
    const opener = editor.modelPickerOpener;
    editor.modelPickerOpener = null;
    const providerDialogOpen = dialog && !dialog.hidden;
    if (providerDialogOpen) {
      dialog.querySelector(".modal-panel").inert = false;
    } else {
      form.inert = false;
      document.querySelector(".settings-sidebar").inert = false;
    }
    if (opener?.isConnected) opener.focus();
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
    form.addEventListener("input", scheduleAutoSave);
    form.addEventListener("change", scheduleAutoSave);
    if (clearCache) {
      clearCache.addEventListener("click", clearTranslationCache);
    }

    if (addService) {
      addService.addEventListener("click", () => openServiceDialog(""));
    }
    for (const list of [serviceList]) {
      if (!list) continue;
      list.addEventListener("click", (event) => {
        const button = closest(event.target, "[data-select-service]");
        if (!button) return;
        editor.selectedServiceId = button.dataset.selectService;
        renderServiceList();
      });
    }
    document.querySelector("#detail-add-model")?.addEventListener("click", addDetailModel);
    detailTestModels?.addEventListener("click", openModelTestDialog);
    startModelTest?.addEventListener("click", runModelTests);
    document.querySelector("#close-model-test")?.addEventListener("click", closeModelTestDialog);
    modelTestDialog?.addEventListener("click", (event) => {
      if (closest(event.target, "[data-close='model-test']")) closeModelTestDialog();
    });
    modelTestDialog?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModelTestDialog();
      } else if (event.key === "Tab") {
        const fields = queryAll("button:not(:disabled)", modelTestDialog);
        const first = fields[0];
        const last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    modelPickerList?.addEventListener("change", updateModelPickerSelection);
    document.querySelector("#model-picker-select-all")?.addEventListener("click", () => selectAllNewModels(true));
    document.querySelector("#model-picker-clear")?.addEventListener("click", () => selectAllNewModels(false));
    modelPickerAdd?.addEventListener("click", applyModelPickerSelection);
    document.querySelector("#model-picker-cancel")?.addEventListener("click", closeModelPicker);
    modelPickerDialog?.addEventListener("click", (event) => {
      if (closest(event.target, "[data-close='model-picker']")) closeModelPicker();
    });
    modelPickerDialog?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModelPicker();
      } else if (event.key === "Tab") {
        const fields = queryAll("button:not(:disabled), input:not(:disabled)", modelPickerDialog);
        const first = fields[0];
        const last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    document.querySelector("#detail-models")?.addEventListener("input", updateDetailModel);
    document.querySelector("#detail-models")?.addEventListener("click", (event) => {
      const button = closest(event.target, '[data-action="remove-detail-model"]');
      if (button) removeDetailModel(button);
    });
    document.querySelector("#edit-service")?.addEventListener("click", () => openServiceDialog(editor.selectedServiceId));
    document.querySelector("#delete-service")?.addEventListener("click", () => deleteService(editor.selectedServiceId));
    detailApiKey?.addEventListener("input", () => {
      const service = serviceById(editor.selectedServiceId);
      if (service) service.apiKey = detailApiKey.value.trim();
    });
    detailBaseUrl?.addEventListener("input", () => {
      const service = serviceById(editor.selectedServiceId);
      if (service) service.baseUrl = detailBaseUrl.value.trim();
    });
    detailFetchModels?.addEventListener("click", fetchDetailModels);
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
        } else if (event.key === "Tab") {
          const fields = queryAll("button:not(:disabled), input, select", dialog);
          const first = fields[0];
          const last = fields[fields.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      });
    }

    if (translationServiceSelect) {
      translationServiceSelect.addEventListener("change", () => {
        editor.translationServiceId = translationServiceSelect.value;
        editor.translationModelId = "";
        renderModelOptions();
        renderServiceList();
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
        renderServiceList();
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

  function scheduleAutoSave(event) {
    if (dialog && dialog.contains(event.target)) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    if (event.type === "change") {
      saveSettings();
      return;
    }
    showStatus("正在保存修改…");
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSettings();
    }, 250);
  }

  async function saveSettings() {

    const realtimeService = serviceById(editor.translationServiceId);
    const immersiveService = serviceById(editor.immersiveTranslationServiceId);
    const dedicatedImmersive = Boolean(immersiveService);
    const translationModelId = realtimeService ? Core.pickModelId(realtimeService, editor.translationModelId) : "";
    const immersiveModelId = dedicatedImmersive ? Core.pickModelId(immersiveService, editor.immersiveTranslationModelId) : "";

    const values = {
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
      llmSentenceSegmentationEnabled: readChecked(llmSentenceSegmentationEnabled, true),
      asrCorrectionEnabled: readChecked(asrCorrectionEnabled, true),
      showOriginalTechnicalTerms: readChecked(showOriginalTechnicalTerms, true),
      sourceLanguage: readValue(sourceLanguage, Core.DEFAULT_SETTINGS.sourceLanguage),
      targetLanguage: readValue(targetLanguage, Core.DEFAULT_SETTINGS.targetLanguage),
      fontScale: Core.normalizeFontScale(readValue(fontScale, Core.DEFAULT_SETTINGS.fontScale)),
      subtitleEnabled: readChecked(subtitleEnabled, true),
      subtitleTranslationMode: readValue(subtitleTranslationMode, "economy") === "full" ? "full" : "economy",
      subtitleLookAheadMinutes: Number(readValue(subtitleLookAheadMinutes, "2"))
    };
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await storageSet(values);
      await storageRemove("deepseekApiKey");
      await storageRemove(["immersiveFallbackProvider", "immersiveGoogleApiKey"]);
      showStatus("设置已自动保存。");
    }).catch(() => showStatus("保存失败，请检查扩展存储空间后重试。"));
    return saveQueue;
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
