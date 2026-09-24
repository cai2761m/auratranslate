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
  const priorityServiceList = document.querySelector("#priority-service-list");
  const detail = document.querySelector("#service-detail");
  const detailApiKey = document.querySelector("#detail-api-key");
  const detailBaseUrl = document.querySelector("#detail-base-url");
  const detailFetchModels = document.querySelector("#detail-fetch-models");
  const BUILTIN_FREE = "builtin:google-free";
  const BUILTIN_CLOUD = "builtin:google-cloud";
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
    selectedServiceId: "",
    dialogVersion: 0,
    detailRequest: null,
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
        renderServiceList();
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

    if (!serviceById(editor.selectedServiceId) && ![BUILTIN_FREE, BUILTIN_CLOUD].includes(editor.selectedServiceId)) {
      editor.selectedServiceId = editor.translationServiceId || BUILTIN_FREE;
    }
    const scroll = document.querySelector(".services-scroll");
    const scrollTop = scroll.scrollTop;
    const focusedId = document.activeElement?.dataset.selectService;
    serviceList.textContent = "";
    priorityServiceList.textContent = "";
    let otherCount = 0;
    for (const service of editor.services) {
      const labels = [];
      if (service.id === editor.translationServiceId) labels.push("默认");
      if (service.id === editor.immersiveTranslationServiceId) labels.push("网页默认");
      const target = labels.length ? priorityServiceList : serviceList;
      target.appendChild(buildServiceEntry(service.id, service.name || "未命名供应方", labels.join(" · ") || `${service.models.length} 个模型`));
      if (!labels.length) otherCount += 1;
    }
    const fallback = immersiveFallbackProvider.value;
    priorityServiceList.appendChild(buildServiceEntry(BUILTIN_FREE, "谷歌翻译", fallback === "google-free" ? "兜底 · 已启用" : "兜底 · 免 Key"));
    priorityServiceList.appendChild(buildServiceEntry(BUILTIN_CLOUD, "Google Cloud Translation", fallback === "google-cloud" ? "兜底 · 已启用" : "兜底 · 官方 API"));
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
    const cloud = editor.selectedServiceId === BUILTIN_CLOUD;
    if (detail.dataset.serviceId !== editor.selectedServiceId) detail.scrollTop = 0;
    detail.dataset.serviceId = editor.selectedServiceId;
    document.querySelector("#detail-name").textContent = service ? service.name || "未命名供应方" : cloud ? "Google Cloud Translation" : "谷歌翻译";
    document.querySelector("#detail-kind").textContent = service ? "自定义供应方" : "内置兜底服务";
    document.querySelector("#detail-actions").hidden = !service;
    document.querySelector("#detail-description").textContent = service
      ? "在此修改密钥和 API 地址；点击编辑维护名称与模型目录。"
      : "用于网页翻译兜底，在“沉浸式翻译”页选择启用。" + (cloud ? "使用独立的 Cloud Translation API Key，请求可能产生费用。" : "免 Key 接口可能限流、不可访问或失效。");
    detailApiKey.value = service ? service.apiKey : cloud ? immersiveGoogleApiKey.value : "";
    detailApiKey.disabled = !service && !cloud;
    detailApiKey.placeholder = service || cloud ? "填写 API Key" : "无需 API Key";
    detailBaseUrl.value = service ? service.baseUrl : cloud ? "https://translation.googleapis.com/language/translate/v2" : "https://translate.googleapis.com/translate_a/single";
    detailBaseUrl.readOnly = !service;
    document.querySelector("#detail-protocol").value = service ? service.apiProtocol : cloud ? "Google Cloud Translation v2" : "Google Translate";
    detailFetchModels.hidden = !service;
    detailFetchModels.disabled = !!editor.detailRequest;
    renderDetailModels(service);
    document.querySelector("#detail-model-status").textContent = "";
  }

  function renderDetailModels(service) {
    const list = document.querySelector("#detail-models");
    list.textContent = "";
    document.querySelector("#detail-model-count").textContent = service ? `(${service.models.length})` : "";
    for (const model of service?.models || []) {
      const item = document.createElement("li");
      item.className = "service-model";
      const id = document.createElement("span");
      id.textContent = model.id;
      const name = document.createElement("span");
      name.textContent = model.displayName || "—";
      item.append(id, name);
      list.appendChild(item);
    }
    if (!list.children.length) {
      const empty = document.createElement("li");
      empty.className = "model-empty";
      empty.textContent = service ? "暂无模型，获取模型列表或点击编辑手动添加。" : "此服务无需选择模型。";
      list.appendChild(empty);
    }
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
    if (!editor.translationServiceId) {
      editor.translationServiceId = draft.id;
    }

    editor.selectedServiceId = draft.id;
    renderServiceOptions();
    renderServiceList();
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
    renderServiceOptions();
    renderServiceList();
    queryAll("[data-select-service]").find((button) => button.dataset.selectService === editor.selectedServiceId)?.focus();
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
      if (version !== editor.dialogVersion) return;
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
      && service.baseUrl === baseUrl && service.apiKey === apiKey;
    try {
      const response = await fetch(Core.buildModelsUrl(baseUrl), {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const ids = extractModelIds(await response.json());
      if (!isCurrent()) return;
      const known = new Set(service.models.map((model) => model.id));
      const added = ids.filter((id) => !known.has(id)).map((id) => ({ id, displayName: "" }));
      service.models.push(...added);
      renderServiceOptions();
      renderServiceList();
      message.textContent = ids.length ? `接口返回 ${ids.length} 个模型，新增 ${added.length} 个。` : "接口没有返回可用模型，请点击编辑手动添加。";
    } catch (error) {
      if (isCurrent()) message.textContent = `获取失败（${error.name === "AbortError" ? "请求超时" : error.message}），已保留现有模型。`;
    } finally {
      clearTimeout(timer);
      editor.detailRequest = null;
      detailFetchModels.disabled = false;
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
    for (const list of [serviceList, priorityServiceList]) {
      if (!list) continue;
      list.addEventListener("click", (event) => {
        const button = closest(event.target, "[data-select-service]");
        if (!button) return;
        editor.selectedServiceId = button.dataset.selectService;
        renderServiceList();
      });
    }
    document.querySelector("#edit-service")?.addEventListener("click", () => openServiceDialog(editor.selectedServiceId));
    document.querySelector("#delete-service")?.addEventListener("click", () => deleteService(editor.selectedServiceId));
    detailApiKey?.addEventListener("input", () => {
      const service = serviceById(editor.selectedServiceId);
      if (service) service.apiKey = detailApiKey.value.trim();
      else if (editor.selectedServiceId === BUILTIN_CLOUD) immersiveGoogleApiKey.value = detailApiKey.value;
    });
    immersiveGoogleApiKey?.addEventListener("input", () => {
      if (editor.selectedServiceId === BUILTIN_CLOUD) detailApiKey.value = immersiveGoogleApiKey.value;
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
