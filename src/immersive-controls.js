// Floating control, dragging, preferences, and display modes.
// Modules share only YTBTImmersive; startup runs last in immersive.js.
(function () {
  "use strict";
  const App = globalThis.YTBTImmersive;
  if (!App) return;
  const { Core, state } = App;

  const BALL_EDGE_PADDING_PX = 8;
  const BALL_DRAG_THRESHOLD_PX = 4;
  function mountControls() {
    if (state.ball || !document.body) {
      return;
    }

    const ballContainer = document.createElement("div");
    ballContainer.className = "ytbt-immersive-tab";
    ballContainer.dataset.ytbtImmersiveRoot = "true";

    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "ytbt-immersive-ball";
    ball.setAttribute("aria-label", "Immersive translate");
    ball.title = "Immersive translate";

    ball.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
    </svg>`;

    ballContainer.appendChild(ball);

    const panel = document.createElement("div");
    panel.className = "ytbt-immersive-panel";
    panel.dataset.ytbtImmersiveRoot = "true";
    panel.hidden = true;
    panel.setAttribute("role", "status");

    ballContainer.addEventListener("pointerdown", handleBallPointerDown, true);
    ballContainer.addEventListener("click", handleBallClick);
    ballContainer.addEventListener("pointerenter", handleControlPointerEnter);
    ballContainer.addEventListener("pointerleave", handleControlPointerLeave);
    panel.addEventListener("pointerenter", handleControlPointerEnter);
    panel.addEventListener("pointerleave", handleControlPointerLeave);
    document.body.appendChild(ballContainer);
    document.body.appendChild(panel);

    state.ball = ballContainer;
    state.ballText = null;
    state.panel = panel;
    loadBallPosition();
    updateBallMode("idle");
    state.preferencesReady.then(maybeAutoTranslate);
  }

  async function loadPreferences() {
    try { state.preferences = { ...await App.storageGet(Core.DEFAULT_SETTINGS) }; }
    catch (_) { /* Manual translation can still report a storage error. */ }
    applyDisplayMode();
  }

  function maybeAutoTranslate() {
    const rule = state.preferences.immersiveSiteRules?.[location.hostname];
    const enabled = rule === "always" || (rule !== "never" && state.preferences.immersiveAutoTranslate === true);
    if (enabled && state.ball && !state.translated && state.mode === "idle") App.translateCurrentPage();
  }

  function applyDisplayMode() {
    const translationOnly = state.preferences.immersiveDisplayMode === "translation";
    document.documentElement.classList.toggle("ytbt-translation-only", translationOnly);
    for (const container of document.querySelectorAll("[data-ytbt-immersive-translation][data-ytbt-state='done']")) {
      const source = container.parentElement;
      if (translationOnly && !source.querySelector(":scope > [data-ytbt-original]")) {
        const original = document.createElement("span");
        original.dataset.ytbtOriginal = "true";
        for (const child of Array.from(source.childNodes)) if (child !== container) original.appendChild(child);
        source.insertBefore(original, container);
      }
    }
    if (!translationOnly) restoreOriginalNodes();
  }

  function restoreOriginalNodes() {
    for (const original of document.querySelectorAll("[data-ytbt-original]")) original.replaceWith(...original.childNodes);
  }

  function handleControlPointerEnter() {
    state.pointerOverControl = true;
    syncPanel();
  }

  function handleControlPointerLeave() {
    state.pointerOverControl = false;
    syncPanel();
  }

  async function handleBallClick(event) {
    event.preventDefault();
    event.stopPropagation();
    App.syncPageIdentity();

    if (state.ballDrag.suppressClick) {
      state.ballDrag.suppressClick = false;
      return;
    }

    if (state.mode === "translating") {
      showStatus("Translation is already running...", true);
      return;
    }

    if (state.translated) {
      state.visible = !state.visible;
      document.documentElement.classList.toggle("ytbt-immersive-hidden", !state.visible);
      showStatus(state.visible ? "Bilingual translations shown." : "Bilingual translations hidden.");
      updateBallMode(state.visible ? "done" : "idle");
      return;
    }

    await App.translateCurrentPage();
  }

  function handleBallPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (state.ballDrag.pointerId != null) {
      cancelBallDrag();
    }

    const rect = state.ball.getBoundingClientRect();
    state.ballDrag.pointerId = event.pointerId;
    state.ballDrag.startClientX = event.clientX;
    state.ballDrag.startClientY = event.clientY;
    state.ballDrag.offsetY = event.clientY - rect.top;
    state.ballDrag.startRight = parseFloat(window.getComputedStyle(state.ball).right) || 0;
    state.ballDrag.active = false;

    state.ball.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", handleBallPointerMove, true);
    document.addEventListener("pointerup", handleBallPointerUp, true);
    document.addEventListener("pointercancel", handleBallPointerCancel, true);
  }

  function handleBallPointerMove(event) {
    const drag = state.ballDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    const distanceX = Math.abs(event.clientX - drag.startClientX);
    const distanceY = Math.abs(event.clientY - drag.startClientY);
    if (!drag.active && (distanceX >= BALL_DRAG_THRESHOLD_PX || distanceY >= BALL_DRAG_THRESHOLD_PX)) {
      drag.active = true;
      state.ball.classList.add("ytbt-immersive-dragging");
    }

    if (!drag.active) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    moveBallToClient(event.clientX, event.clientY);
  }

  function handleBallPointerUp(event) {
    const drag = state.ballDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    if (drag.active) {
      event.preventDefault();
      event.stopPropagation();
      drag.suppressClick = true;
      state.ball.style.right = "0px";
      saveBallPosition();
    }
    cancelBallDrag();
  }

  function handleBallPointerCancel(event) {
    if (event && state.ballDrag.pointerId !== event.pointerId) {
      return;
    }
    if (state.ballDrag.active && state.ball) {
      state.ball.style.right = "0px";
    }
    cancelBallDrag();
  }

  function cancelBallDrag() {
    if (state.ball && state.ballDrag.pointerId != null) {
      try {
        state.ball.releasePointerCapture(state.ballDrag.pointerId);
      } catch (error) {
        // Ignore browsers that already released the pointer.
      }
      state.ball.classList.remove("ytbt-immersive-dragging");
    }

    document.removeEventListener("pointermove", handleBallPointerMove, true);
    document.removeEventListener("pointerup", handleBallPointerUp, true);
    document.removeEventListener("pointercancel", handleBallPointerCancel, true);

    state.ballDrag.pointerId = null;
    state.ballDrag.active = false;
  }

  function moveBallToClient(clientX, clientY) {
    if (!state.ball) {
      return;
    }

    const rect = state.ball.getBoundingClientRect();
    const halfHeight = rect.height / 2 || 16;
    const minCenterY = BALL_EDGE_PADDING_PX + halfHeight;
    const maxCenterY = window.innerHeight - BALL_EDGE_PADDING_PX - halfHeight;
    const rawCenterY = clientY - state.ballDrag.offsetY + halfHeight;
    const centerY = App.clamp(rawCenterY, Math.min(minCenterY, maxCenterY), Math.max(minCenterY, maxCenterY));

    state.ballTopPct = (centerY / Math.max(1, window.innerHeight)) * 100;

    let newRight = state.ballDrag.startRight - (clientX - state.ballDrag.startClientX);
    newRight = App.clamp(newRight, 0, window.innerWidth - rect.width);
    state.ball.style.right = `${newRight}px`;

    applyBallPosition();
  }

  function applyBallPosition() {
    const topPct = App.clamp(Number(state.ballTopPct) || App.DEFAULT_BALL_TOP_PCT, 4, 96);
    state.ballTopPct = topPct;

    if (state.ball) {
      state.ball.style.top = `${topPct}%`;
    }
    if (state.panel) {
      state.panel.style.top = `min(calc(${topPct}% + 24px), calc(100vh - 64px))`;
    }
  }

  async function loadBallPosition() {
    try {
      const values = await App.storageGet({ immersiveBallTopPct: App.DEFAULT_BALL_TOP_PCT });
      state.ballTopPct = normalizeBallTopPct(values.immersiveBallTopPct);
      applyBallPosition();
    } catch (error) {
      applyBallPosition();
    }
  }

  async function saveBallPosition() {
    const topPct = normalizeBallTopPct(state.ballTopPct);
    state.ballTopPct = topPct;
    applyBallPosition();
    try {
      await App.storageSet({ immersiveBallTopPct: topPct });
    } catch (error) {
      // Position persistence is nice-to-have; dragging should still work.
    }
  }

  function normalizeBallTopPct(value) {
    const number = Number(value);
    return Number.isFinite(number) ? App.clamp(number, 4, 96) : App.DEFAULT_BALL_TOP_PCT;
  }

  function updateBallMode(mode) {
    state.mode = mode;
    if (!state.ball) {
      return;
    }
    state.ball.dataset.ytbtState = mode;
  }

  // The panel is a hover surface: translation progress is recorded here but is
  // never pushed on screen on its own. Only the pointer over the floating
  // control opens it, so reading the page stays unobstructed while the
  // background work runs.
  function showStatus(message, persistent) {
    if (state.panelTimer) {
      clearTimeout(state.panelTimer);
      state.panelTimer = null;
    }

    state.panelStatusText = message || "";
    state.panelStatusPersistent = Boolean(persistent) && Boolean(state.panelStatusText);

    if (state.panelStatusText && !state.panelStatusPersistent) {
      state.panelTimer = setTimeout(() => {
        state.panelTimer = null;
        state.panelStatusText = "";
        state.panelStatusPersistent = false;
        syncPanel();
      }, 3600);
    }

    syncPanel();
  }

  function syncPanel() {
    const panel = state.panel;
    if (!panel) {
      return;
    }

    const text = state.panelStatusText;
    // Mirror the stored status exactly: a cleared status must not leave the
    // previous message behind for the next hover to reveal.
    if (panel.textContent !== text) {
      panel.textContent = text;
    }
    panel.hidden = !text || !state.pointerOverControl;
  }

  Object.assign(App, {
    mountControls,
    loadPreferences,
    maybeAutoTranslate,
    applyDisplayMode,
    restoreOriginalNodes,
    updateBallMode,
    showStatus
  });
})();
