window.__ModuleLoader__.load({
  id: "dsh-desktop-tauriapp",
  factory: (require) => {
var module = { exports: {} };
var exports = module.exports;

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  applyAdvancedShell: () => applyAdvancedShell,
  inject: () => inject,
  parseDesktopClientEnvironment: () => parseDesktopClientEnvironment,
  requestDesktopClientEnvironment: () => requestDesktopClientEnvironment
});
module.exports = __toCommonJS(index_exports);

// src/client/local-chrome.ts
var STRIP_HEIGHT = {
  darwin: 28,
  win32: 32,
  linux: 32
};
var MACOS_COLLAPSED_SIDEBAR = 90;
var COLLAPSED_RAIL = 56;
var CAPTION_CONTROLS_WIDTH = 138;
var FRAME_LAYER_SELECTOR = "[data-shell-overlay]";
function tauriWindowCommand(command) {
  try {
    const internals2 = window.__TAURI_INTERNALS__;
    if (internals2?.invoke !== void 0) void internals2.invoke(command).catch(() => void 0);
  } catch {
  }
}
function makeCaptionButton(aria, extraClass, svgPath) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `dshDesktopCaptionButton${extraClass ? ` ${extraClass}` : ""}`;
  button.setAttribute("aria-label", aria);
  button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${svgPath}</svg>`;
  return button;
}
function buildWindowControls() {
  const box = document.createElement("div");
  box.className = "dshDesktopWindowControls";
  box.appendChild(makeCaptionButton("\u6700\u5C0F\u5316", "", '<path d="M1 6h10" stroke="currentColor" strokeWidth="1" fill="none" />'));
  box.appendChild(makeCaptionButton("\u6700\u5927\u5316", "", '<rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />'));
  box.appendChild(makeCaptionButton("\u5173\u95ED", "dshDesktopCaptionButton-close", '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1" />'));
  box.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const action = button?.getAttribute("aria-label");
    if (action === "\u6700\u5C0F\u5316") tauriWindowCommand("plugin:window|minimize");
    else if (action === "\u6700\u5927\u5316") tauriWindowCommand("plugin:window|toggle_maximize");
    else if (action === "\u5173\u95ED") tauriWindowCommand("plugin:window|close");
  });
  return box;
}
function locateLayout() {
  const layer = document.querySelector(FRAME_LAYER_SELECTOR);
  const frame = layer?.parentElement;
  if (frame === null || frame === void 0) return null;
  const children = Array.from(frame.children).filter((el) => el instanceof HTMLElement);
  return { frame, sidebar: children[0] ?? frame, center: children[1] ?? null, rightColumn: children[2] ?? null };
}
function installLocalChrome(platform) {
  const height = STRIP_HEIGHT[platform];
  const host = document.createElement("div");
  host.className = "dshDesktopChromeHost";
  const strip = document.createElement("div");
  strip.className = "dshDesktopChromeStrip";
  const drag = document.createElement("div");
  drag.className = "dshDesktopChromeDrag";
  drag.setAttribute("data-tauri-drag-region", "");
  strip.appendChild(drag);
  if (platform !== "darwin") strip.appendChild(buildWindowControls());
  host.appendChild(strip);
  document.body.appendChild(host);
  const STATUS_BAR_HEIGHT = 24;
  const STATUS_TEXT = {
    0: "\u521D\u59CB\u5316",
    1: "\u542F\u52A8\u4E2D",
    2: "\u8FD0\u884C\u4E2D",
    3: "\u590D\u7528\u5916\u90E8\u5B9E\u4F8B",
    4: "\u91CD\u542F\u4E2D",
    5: "\u670D\u52A1\u5F02\u5E38",
    6: "\u670D\u52A1\u4E0B\u7EBF",
    7: "\u8FDC\u7A0B"
  };
  const STATUS_COLOR = {
    0: "#9ca3af",
    1: "#f59e0b",
    2: "#22c55e",
    3: "#22c55e",
    4: "#f59e0b",
    5: "#ef4444",
    6: "#ef4444",
    7: "#3b82f6"
  };
  function tauriInvoke() {
    const w = window;
    if (w.__TAURI__?.core?.invoke) return w.__TAURI__.core.invoke;
    if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke;
    return void 0;
  }
  let raf = 0;
  let attempts = 0;
  let mountTimer = 0;
  let statusTimer = 0;
  let resizeObserver = null;
  let mutationObserver = null;
  const bar = document.createElement("div");
  bar.className = "dshDesktopStatusBar";
  bar.innerHTML = '<span class="dshDesktopStatusDot" aria-hidden="true"></span><span class="dshDesktopStatusText"></span>';
  host.appendChild(bar);
  const railPadLeft = document.createElement("div");
  const railPadRight = document.createElement("div");
  railPadLeft.className = "dshDesktopRailPad";
  railPadRight.className = "dshDesktopRailPad";
  host.append(railPadLeft, railPadRight);
  const refreshStatus = () => {
    const invoke5 = tauriInvoke();
    if (!invoke5) return;
    void invoke5("get_dsh_status", {}).then((value) => {
      const s = value.status;
      if (typeof s !== "number") return;
      const dot = bar.querySelector(".dshDesktopStatusDot");
      const text = bar.querySelector(".dshDesktopStatusText");
      const label = STATUS_TEXT[s] ?? `\u72B6\u6001 ${s}`;
      if (dot !== null) dot.style.background = STATUS_COLOR[s] ?? "#9ca3af";
      if (text !== null) text.textContent = label;
      bar.title = `dsh\uFF1A${label}`;
    }).catch(() => {
    });
  };
  refreshStatus();
  statusTimer = window.setInterval(refreshStatus, 5e3);
  const schedule = () => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync();
    });
  };
  const SIDEBAR_SCROLL_MARK = "data-dsh-desktop-scroll";
  let scrollRegion = null;
  let scrollRoot = null;
  const minWidthPatched = [];
  const overflowXPatched = [];
  const isScrollableY = (el) => {
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll";
  };
  const ensureSidebarScroll = (sidebar) => {
    let root = null;
    const slot = document.querySelector('[data-slot="sidebar"]');
    if (slot !== null) {
      root = Array.from(slot.children).find((el) => el instanceof HTMLElement) ?? null;
    }
    if (root === null) {
      root = Array.from(sidebar.children).find((el) => el instanceof HTMLElement) ?? null;
    }
    if (root === null) return;
    root.style.flexWrap = "nowrap";
    root.style.width = "100%";
    root.style.maxWidth = "100%";
    root.style.minWidth = "0";
    root.style.overflowX = "auto";
    scrollRoot = root;
    const region = Array.from(root.children).find((el) => {
      return el instanceof HTMLElement && getComputedStyle(el).flexGrow === "1";
    });
    if (region === void 0) return;
    scrollRegion = region;
    minWidthPatched.length = 0;
    const visit = (el) => {
      const style = getComputedStyle(el);
      if (style.display.includes("flex")) {
        el.style.minWidth = "0";
        minWidthPatched.push(el);
      }
      if (isScrollableY(el)) {
        el.style.overflowX = "auto";
        overflowXPatched.push(el);
      }
      for (const child of el.children) {
        if (child instanceof HTMLElement) visit(child);
      }
    };
    for (const child of Array.from(region.children)) {
      if (child instanceof HTMLElement) visit(child);
    }
    if (root.getAttribute(SIDEBAR_SCROLL_MARK) === null) {
      root.setAttribute(SIDEBAR_SCROLL_MARK, "");
    }
  };
  const sync = () => {
    const layout = locateLayout();
    if (layout === null) {
      if (attempts++ < 1200) schedule();
      return;
    }
    attempts = 0;
    const { frame, sidebar, center, rightColumn } = layout;
    ensureSidebarScroll(sidebar);
    const sidebarWidth = sidebar.offsetWidth;
    sidebar.style.paddingBottom = `${STATUS_BAR_HEIGHT}px`;
    bar.style.cssText = `left:0;bottom:0;width:${sidebarWidth}px;height:${STATUS_BAR_HEIGHT}px;`;
    if (platform === "darwin") {
      const collapsed = frame.hasAttribute("data-sidebar-collapsed");
      frame.style.setProperty("transition", "none", "important");
      strip.style.cssText = `left:0;top:0;width:${sidebarWidth}px;height:${height}px;`;
      drag.style.cssText = "position:absolute;inset:0;";
      sidebar.style.paddingTop = `${height}px`;
      const sidePad = collapsed ? (MACOS_COLLAPSED_SIDEBAR - COLLAPSED_RAIL) / 2 : 0;
      sidebar.style.paddingLeft = sidePad ? `${sidePad}px` : "";
      sidebar.style.paddingRight = sidePad ? `${sidePad}px` : "";
      if (collapsed) {
        railPadLeft.style.cssText = `display:block;left:0;top:${height}px;width:${sidePad}px;bottom:${STATUS_BAR_HEIGHT}px;`;
        railPadRight.style.cssText = `display:block;left:${sidebarWidth - sidePad}px;top:${height}px;width:${sidePad}px;bottom:${STATUS_BAR_HEIGHT}px;`;
      } else {
        railPadLeft.style.display = "none";
        railPadRight.style.display = "none";
      }
      if (collapsed) {
        sidebar.style.setProperty("border-right", "none", "important");
      } else {
        sidebar.style.removeProperty("border-right");
      }
      if (collapsed) widenCollapsedRail(frame);
    } else {
      strip.style.cssText = `left:${sidebarWidth}px;right:0;top:0;height:${height}px;`;
      drag.style.cssText = `position:absolute;top:0;bottom:0;left:0;right:${CAPTION_CONTROLS_WIDTH}px;`;
      if (center !== null) center.style.paddingTop = `${height}px`;
      const rightPanel = rightColumn?.querySelector("[data-sidebar-right-panel]");
      if (rightPanel !== null) rightPanel.style.top = `${height}px`;
    }
  };
  const widenCollapsedRail = (frame) => {
    const collapsed = frame.hasAttribute("data-sidebar-collapsed");
    const current = getComputedStyle(frame).gridTemplateColumns.split(" ").filter(Boolean);
    if (current.length === 0) return;
    const desired = current.slice();
    if (collapsed && parseInt(desired[0], 10) !== MACOS_COLLAPSED_SIDEBAR) {
      desired[0] = `${MACOS_COLLAPSED_SIDEBAR}px`;
    }
    const joined = desired.join(" ");
    if (joined !== current.join(" ")) {
      frame.style.setProperty("grid-template-columns", joined, "important");
    }
  };
  try {
    resizeObserver = new ResizeObserver(schedule);
    mutationObserver = new MutationObserver(schedule);
  } catch {
    resizeObserver = null;
    mutationObserver = null;
  }
  const attachObservers = () => {
    const layout = locateLayout();
    if (layout === null) return false;
    if (resizeObserver !== null) {
      resizeObserver.observe(layout.frame);
      resizeObserver.observe(layout.sidebar);
      if (layout.center !== null) resizeObserver.observe(layout.center);
      if (layout.rightColumn !== null) resizeObserver.observe(layout.rightColumn);
    }
    if (mutationObserver !== null) {
      mutationObserver.observe(layout.frame, {
        attributes: true,
        attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed", "style"]
      });
      if (layout.rightColumn !== null) {
        mutationObserver.observe(layout.rightColumn, { childList: true, subtree: true });
      }
    }
    return true;
  };
  if (!attachObservers()) {
    mountTimer = window.setInterval(() => {
      if (attachObservers()) {
        window.clearInterval(mountTimer);
        sync();
      }
    }, 250);
  }
  sync();
  return () => {
    if (raf !== 0) cancelAnimationFrame(raf);
    if (mountTimer !== 0) window.clearInterval(mountTimer);
    if (statusTimer !== 0) window.clearInterval(statusTimer);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    const found = locateLayout();
    if (found !== null) {
      found.sidebar.style.paddingTop = "";
      found.sidebar.style.paddingBottom = "";
      found.sidebar.style.paddingLeft = "";
      found.sidebar.style.paddingRight = "";
      found.sidebar.style.removeProperty("border-right");
      found.frame.style.removeProperty("transition");
      found.frame.style.removeProperty("grid-template-columns");
      if (found.center !== null) found.center.style.paddingTop = "";
      const rightPanel = found.rightColumn?.querySelector("[data-sidebar-right-panel]");
      if (rightPanel !== null) rightPanel.style.top = "";
    }
    for (const el of minWidthPatched) el.style.minWidth = "";
    for (const el of overflowXPatched) el.style.overflowX = "";
    minWidthPatched.length = 0;
    overflowXPatched.length = 0;
    if (scrollRoot !== null) {
      scrollRoot.style.flexWrap = "";
      scrollRoot.style.width = "";
      scrollRoot.style.maxWidth = "";
      scrollRoot.style.minWidth = "";
      scrollRoot.style.overflowX = "";
      scrollRoot.removeAttribute(SIDEBAR_SCROLL_MARK);
      scrollRoot = null;
    }
    if (scrollRegion !== null) {
      scrollRegion = null;
    }
    host.remove();
  };
}

// src/client/styles.ts
var ADVANCED_STYLES = `
body[data-dsh-desktop-tauriapp-mode="advanced"] { margin: 0; }
.dshDesktopChromeHost { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
.dshDesktopChromeStrip { position: absolute; display: flex; align-items: stretch; pointer-events: auto; }
/* \u62D6\u62FD\u6761\u80CC\u666F\uFF1A\u6309\u5E73\u53F0\u5339\u914D\u6240\u8986\u76D6\u533A\u57DF\u7684\u4E3B\u9898\u80CC\u666F\uFF08macOS \u8986\u76D6\u4FA7\u8FB9\u680F\u3001Win/Linux \u8986\u76D6\u4E2D\u95F4\u533A\uFF09\u3002
   \u5BF9\u9F50 better-sidebar \u505A\u6CD5\uFF1A\u6CE8\u5165\u5143\u7D20\u663E\u5F0F\u8BBE --dsw-alias-bg-* / --dsw-specific-* \u800C\u975E\u900F\u660E\u4F9D\u8D56\u5E95\u5C42\u900F\u51FA\u3002 */
body[data-dsh-desktop-platform="darwin"] .dshDesktopChromeStrip { background: var(--dsw-specific-sidebar-fill); }
body[data-dsh-desktop-platform="win32"] .dshDesktopChromeStrip,
body[data-dsh-desktop-platform="linux"] .dshDesktopChromeStrip { background: var(--dsw-alias-bg-base); }
/* macOS \u6298\u53E0\u52A0\u5BBD\u533A\u4E24\u4FA7\u88C5\u9970\u6761\uFF08local-chrome \u6298\u53E0\u65F6\u5B9A\u4F4D\u5728\u9876\u90E8\u6761\u4E0E\u72B6\u6001\u6761\u4E4B\u95F4\uFF09\uFF1A
   \u4E0E\u9876\u90E8\u6761/\u72B6\u6001\u6761\u540C\u4E00\u5C42\u4E3B\u9898\u586B\u5145\uFF0C\u4FDD\u8BC1\u6574\u6761\u8F68\u9053\u53E0\u52A0\u5C42\u6570\u4E00\u81F4\uFF08\u76AE\u80A4\u4E3A\u534A\u900F\u660E\u53E0\u52A0\u4E3B\u9898\uFF0C\u89C1 #37\uFF09\u3002
   display:none \u517C\u4F5C\u5C55\u5F00\u6001\u9ED8\u8BA4\uFF1B\u6298\u53E0\u6001\u7531\u5185\u8054\u6837\u5F0F\u663E\u5F0F display:block \u6253\u5F00\u3002 */
.dshDesktopRailPad { position: absolute; display: none; background: var(--dsw-specific-sidebar-fill); pointer-events: none; }
.dshDesktopChromeDrag { user-select: none; }
.dshDesktopStatusBar { position: absolute; background: var(--dsw-specific-sidebar-fill); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary, currentColor); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); pointer-events: auto; user-select: none; }
.dshDesktopStatusDot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
/* \u8BBE\u7F6E\u5F39\u7A97\u5DE6\u4FA7 tab \u5217\u53EF\u6EDA\u52A8\uFF08dsh \u4E0A\u6E38 navList \u65E0 overflow\uFF0Ctab \u591A\u4E86\u88AB\u622A\u65AD\uFF09\uFF1A
   \u7528\u5F39\u7A97\u7A33\u5B9A\u6807\u8BB0\u5B9A\u4F4D\uFF0C\u4E0D\u4F9D\u8D56 hash \u7C7B\u540D\u3002 */
[role="dialog"][aria-modal="true"] nav { min-height: 0; overflow: hidden; }
[role="dialog"][aria-modal="true"] nav > div:last-child { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.dshDesktopWindowControls { position: absolute; top: 0; right: 0; height: 100%; display: flex; align-items: stretch; }
.dshDesktopCaptionButton { width: 46px; border: none; margin: 0; padding: 0; background: transparent; color: var(--dsw-alias-label-primary, currentColor); display: grid; place-items: center; cursor: default; }
.dshDesktopCaptionButton:hover { background: rgba(128, 128, 128, 0.18); }
.dshDesktopCaptionButton-close:hover { background: #e81123; color: #fff; }
.dshDesktopCaptionButton svg { width: 12px; height: 12px; display: block; }
/* \u4FA7\u8FB9\u680F\u5185\u5BB9\u533A\u6EDA\u52A8\uFF08local-chrome.ts ensureSidebarScroll \u6253\u7A33\u5B9A\u6807\u8BB0\uFF1B\u5185\u8054 overflow
   \u5DF2\u8986\u76D6 stock \u7684 hidden\uFF0C\u8FD9\u91CC\u53EA\u505A\u6EDA\u52A8\u6761\u89C2\u611F\u4E0E\u6EDA\u52A8\u94FE\u6536\u655B\uFF09\u3002 */
[data-dsh-desktop-scroll] { overscroll-behavior: contain; scrollbar-width: thin; }
[data-dsh-desktop-scroll]::-webkit-scrollbar { width: 8px; height: 8px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.4)); border-radius: 4px; }
[data-dsh-desktop-scroll]::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.6)); }
`;
function installAdvancedStyles() {
  const style = document.createElement("style");
  style.dataset.plugin = "dsh-desktop-tauriapp";
  style.dataset.pluginCss = "dsh-desktop-tauriapp/local-chrome";
  style.textContent = ADVANCED_STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}

// src/client/advanced-shell.ts
function applyAdvancedShell(ctx, environment) {
  if (environment.mode !== "advanced") {
    throw new Error(`dsh-desktop-tauriapp: advanced shell received mode ${JSON.stringify(environment.mode)}`);
  }
  ctx.effect(() => {
    document.body.dataset.dshDesktopMode = "advanced";
    document.body.dataset.dshDesktopPlatform = environment.platform;
    const removeStyles = installAdvancedStyles();
    return () => {
      removeStyles();
      delete document.body.dataset.dshDesktopMode;
      delete document.body.dataset.dshDesktopPlatform;
    };
  }, "desktop: advanced shell styles");
  ctx.effect(() => installLocalChrome(environment.platform), "desktop: local window chrome");
}

// src/client/downloads-tab.tsx
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var DownloadIcon = import_dsh_client_ui_primitives.IconDownloadOutline16 ?? import_dsh_client_ui_primitives.IconDownloadOutlineRegular;
var TAB_ID = "dsh-desktop-tauriapp/downloads";
var TAB_KIND = "dsh-desktop-tauriapp/downloads";
function invoke(cmd, args) {
  const w = window;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args);
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args);
  return Promise.reject(new Error("no tauri ipc"));
}
function hasIpc() {
  const w = window;
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
var STATUS_LABEL = {
  choosing_path: "\u7B49\u5F85\u9009\u62E9\u4F4D\u7F6E",
  queued: "\u6392\u961F\u4E2D",
  downloading: "\u4E0B\u8F7D\u4E2D",
  paused: "\u5DF2\u6682\u505C",
  completed: "\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25",
  cancelled: "\u5DF2\u53D6\u6D88"
};
function DownloadsPanel() {
  const [tasks, setTasks] = (0, import_react.useState)([]);
  const [concurrency, setConcurrency] = (0, import_react.useState)(3);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const timerRef = (0, import_react.useRef)(null);
  const tasksRef = (0, import_react.useRef)([]);
  (0, import_react.useEffect)(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const list = await invoke("list_downloads");
        const settings = await invoke("get_download_settings");
        if (!alive) return;
        setTasks(list);
        setConcurrency(settings.concurrency);
      } catch {
      }
    };
    void refresh();
    const tick = () => {
      void refresh();
      const active = tasksRef.current.some((t) => t.status === "downloading" || t.status === "queued" || t.status === "choosing_path");
      timerRef.current = window.setTimeout(tick, active ? 600 : 2500);
    };
    timerRef.current = window.setTimeout(tick, 600);
    return () => {
      alive = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);
  tasksRef.current = tasks;
  const act = async (cmd, args) => {
    setBusy(true);
    try {
      await invoke(cmd, args);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const finishedCount = tasks.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled").length;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 12 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--dsw-alias-border-l, rgba(255,255,255,.08))" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "var(--dsw-alias-label-secondary, #9aa3af)" }, children: [
        "\u5E76\u53D1 ",
        concurrency
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          disabled: busy || finishedCount === 0,
          onClick: () => void act("clear_finished_downloads", {}),
          style: { padding: "2px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l, rgba(255,255,255,.14))", background: "transparent", color: "inherit", cursor: "pointer" },
          children: "\u6E05\u7A7A\u5DF2\u5B8C\u6210"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }, children: tasks.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { padding: "28px 16px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #6b7280)" }, children: "\u6682\u65E0\u4E0B\u8F7D\u4EFB\u52A1\u3002\u9875\u9762\u91CC\u7684\u4E0B\u8F7D\uFF08session log\u3001\u6587\u4EF6\u7B49\uFF09\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002" }) : tasks.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l, rgba(255,255,255,.05))" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary, #e7eaf0)" }, title: t.filename, children: t.filename }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary, #6b7280)", fontSize: 11 }, children: STATUS_LABEL[t.status] })
      ] }),
      (t.status === "downloading" || t.status === "queued" || t.status === "paused") && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 5 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: 4, borderRadius: 2, background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))", overflow: "hidden" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            style: {
              height: "100%",
              width: t.total ? `${Math.min(100, t.received / t.total * 100)}%` : "0%",
              background: "var(--dsw-alias-brand-primary-new-color, #4176e6)",
              transition: "width .3s"
            }
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 3, color: "var(--dsw-alias-label-tertiary, #6b7280)", fontSize: 11 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
            fmtBytes(t.received),
            t.total ? ` / ${fmtBytes(t.total)}` : "",
            t.resumed ? " \xB7 \u7EED\u4F20" : ""
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }, title: t.targetPath, children: t.targetPath })
        ] })
      ] }),
      t.error != null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 3, color: "#f87171", fontSize: 11 }, title: t.error, children: t.error }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: 5 }, children: [
        (t.status === "downloading" || t.status === "queued") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("pause_download", { id: t.id }), children: "\u6682\u505C" }),
        (t.status === "paused" || t.status === "failed") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("resume_download", { id: t.id }), children: t.status === "paused" && t.kind === "blob" ? "\u6062\u590D(\u4E0D\u53EF\u7528)" : "\u6062\u590D" }),
        !["completed", "cancelled"].includes(t.status) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("cancel_download", { id: t.id }), children: "\u53D6\u6D88" }),
        t.status === "completed" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextButton, { onClick: () => void act("reveal_download", { id: t.id }), children: "\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u4E2D\u663E\u793A" })
      ] })
    ] }, t.id)) })
  ] });
}
function TextButton({ children, onClick }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      onClick,
      style: {
        padding: "1px 8px",
        fontSize: 11,
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l, rgba(255,255,255,.14))",
        background: "transparent",
        color: "inherit",
        cursor: "pointer"
      },
      children
    }
  );
}
function DownloadsTabTitle() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadIcon, {}),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 4 }, children: "\u4E0B\u8F7D" })
  ] });
}
function DownloadsHeaderButton() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives.Button,
    {
      variant: "ghost",
      size: "sm",
      icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadIcon, {}),
      title: "\u4E0B\u8F7D\u7BA1\u7406\u5668",
      "aria-label": "\u4E0B\u8F7D\u7BA1\u7406\u5668",
      onClick: () => {
        if (headerOpenAction) headerOpenAction();
      }
    }
  );
}
var headerOpenAction = null;
function registerDownloadsTab(ctx) {
  if (!hasIpc()) {
    ctx?.logger?.warn?.("downloads-tab: \u65E0 Tauri IPC\uFF08\u7EAF\u6D4F\u89C8\u5668\uFF09\uFF0C\u8DF3\u8FC7\u6CE8\u518C");
    return;
  }
  const root = ctx;
  root.inject(["sidebarRightTabs"], (sub) => {
    const disposers = [];
    const own = (r) => {
      if (typeof r === "function") disposers.push(r);
    };
    try {
      const tabs = sub.sidebarRightTabs;
      const slots = sub.slots;
      if (tabs === void 0 || typeof tabs.register !== "function") return;
      if (slots === void 0 || typeof slots.register !== "function") return;
      own(tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => "\u4E0B\u8F7D",
        guide: [
          {
            id: "downloads",
            order: 30,
            title: () => "\u4E0B\u8F7D",
            description: () => "\u684C\u9762\u58F3\u4E0B\u8F7D\u7BA1\u7406\u5668\uFF1A\u8FDB\u5EA6\u3001\u6682\u505C/\u6062\u590D\u3001\u5E76\u884C\u4E0E\u5386\u53F2",
            icon: DownloadIcon
          }
        ]
      }));
      own(slots.inject(
        "sidebar.right.pane.tab",
        () => slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, DownloadsPanel)
      ));
      own(slots.inject(
        "sidebar.right.pane.tab.title",
        () => slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, DownloadsTabTitle)
      ));
    } catch {
      for (const dispose of disposers) dispose();
      return;
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
  root.inject(["slots"], (sub) => {
    const slots = sub.slots;
    if (slots === void 0 || typeof slots.register !== "function") return;
    try {
      headerOpenAction = () => {
        const sidebarRight = ctx.get?.("sidebarRight");
        if (sidebarRight && typeof sidebarRight.openTab === "function") {
          sidebarRight.openTab(TAB_KIND);
        }
      };
      const dispose = slots.inject(
        "conversation.session.header.utilities",
        () => slots.register({
          name: "conversation.session.header.utilities",
          id: "dsh-desktop-tauriapp:downloads-button",
          order: 20,
          // better-sidebar 开合钮 order=10，排其后
          registrant: "dsh-desktop-tauriapp"
        }, DownloadsHeaderButton)
      );
      if (typeof dispose === "function") return dispose;
    } catch {
    }
    return void 0;
  });
}

// src/client/download-intercept.ts
function invoke2(cmd, args) {
  const w = window;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args);
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args);
  return Promise.reject(new Error("no tauri ipc"));
}
function hasIpc2() {
  const w = window;
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}
function shouldIntercept(href, hasDownloadAttr) {
  if (!hasDownloadAttr || href === null) return false;
  return /^blob:/i.test(href) || /^data:/i.test(href);
}
function filenameFromAnchor(downloadAttr, href) {
  const fromAttr = (downloadAttr ?? "").trim();
  if (fromAttr !== "") return fromAttr;
  if (/^data:/i.test(href)) return "download";
  try {
    const base = typeof location !== "undefined" ? location.href : void 0;
    const u = new URL(href, base);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ?? "download";
  } catch {
    return "download";
  }
}
var CHUNK_BYTES = 512 * 1024;
function base64Of(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const SEG = 32768;
  for (let i = 0; i < bytes.length; i += SEG) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SEG));
  }
  return btoa(bin);
}
async function waitPathChosen(id, signal) {
  for (let i = 0; i < 600; i++) {
    if (signal.aborted) return false;
    try {
      const tasks = await invoke2("list_downloads");
      const t = tasks.find((x) => x.id === id);
      if (t === void 0) return false;
      if (t.status === "downloading") return true;
      if (t.status !== "choosing_path") return false;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
function installDownloadInterceptor() {
  if (!hasIpc2()) return;
  if (window.__dshDownloadsIntercept === true) return;
  window.__dshDownloadsIntercept = true;
  document.addEventListener(
    "click",
    (ev) => {
      if (ev.defaultPrevented) return;
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (anchor === null) return;
      const href = anchor.getAttribute("href");
      if (!shouldIntercept(href, anchor.hasAttribute("download"))) return;
      ev.preventDefault();
      ev.stopPropagation();
      const filename = filenameFromAnchor(anchor.getAttribute("download"), href ?? "");
      void transferBlobToShell(href ?? "", filename);
    },
    true
  );
}
async function transferBlobToShell(href, filename) {
  try {
    const resp = await fetch(href);
    if (!resp.ok) throw new Error(`fetch ${href} -> ${resp.status}`);
    const blob = await resp.blob();
    const id = await invoke2("start_blob_download", { filename, total: blob.size });
    if (id === null || id === void 0) return;
    const signal = { aborted: false };
    if (!await waitPathChosen(id, signal)) return;
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const chunk = blob.slice(offset, offset + CHUNK_BYTES);
      const b64 = base64Of(await chunk.arrayBuffer());
      const ok = await invoke2("save_blob_chunk", { id, chunk: b64 });
      if (!ok) return;
    }
    await invoke2("finish_blob_download", { id });
  } catch (err) {
    console.warn("[dsh-desktop] blob \u4E0B\u8F7D\u8F6C\u4EA4\u5931\u8D25\uFF1A", err);
  }
}

// src/client/desktop-browser-bridge.ts
function internals() {
  const w = window;
  return w.__TAURI_INTERNALS__;
}
function invoke3(cmd, args) {
  const i = internals();
  if (!i?.invoke) return Promise.reject(new Error("no-tauri-ipc"));
  return i.invoke(cmd, args, void 0);
}
var mirrors = /* @__PURE__ */ new Map();
var openListeners = /* @__PURE__ */ new Map();
var rectSchedulers = /* @__PURE__ */ new Map();
var rectPollTimer;
function ensureRectPoll() {
  if (rectPollTimer !== void 0) return;
  rectPollTimer = window.setInterval(() => {
    for (const [lease, schedule] of rectSchedulers) {
      if (!mirrors.has(lease)) {
        rectSchedulers.delete(lease);
        continue;
      }
      schedule();
    }
  }, 400);
}
function mirrorOf(lease) {
  let m = mirrors.get(lease);
  if (!m) {
    m = {
      url: `about:blank#${lease}`,
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      el: void 0,
      shown: false,
      overlayHidden: false,
      rectPending: false
    };
    mirrors.set(lease, m);
  }
  return m;
}
function makeEvent(type, props) {
  const ev = new Event(type);
  if (props) Object.assign(ev, props);
  return ev;
}
function applyPush(push) {
  const m = mirrors.get(push.lease);
  if (!m) return;
  m.url = push.url;
  m.title = push.title;
  m.loading = push.loading;
  m.canGoBack = push.canGoBack;
  m.canGoForward = push.canGoForward;
  const el = m.el;
  if (!el) return;
  switch (push.kind) {
    case "started":
      el.dispatchEvent(makeEvent("did-start-navigation", { isMainFrame: true }));
      el.dispatchEvent(makeEvent("did-start-loading"));
      break;
    case "finished":
      el.dispatchEvent(makeEvent("did-stop-loading"));
      el.dispatchEvent(makeEvent("did-navigate"));
      break;
    case "failed":
      el.dispatchEvent(makeEvent("did-stop-loading"));
      el.dispatchEvent(makeEvent("did-fail-load", { isMainFrame: true }));
      break;
    case "title":
      el.dispatchEvent(makeEvent("page-title-updated"));
      break;
    case "gone":
      el.dispatchEvent(makeEvent("render-process-gone"));
      break;
    default:
      break;
  }
}
function patchElement(el, lease, m) {
  const fireAndForget = (cmd, args) => {
    void invoke3(cmd, args).catch((e) => {
      console.error("[desktop-browser-bridge] \u547D\u4EE4\u5931\u8D25", cmd, e);
    });
  };
  el.loadURL = (url) => invoke3("browser_guest_navigate", { lease, url }).then(
    () => void 0,
    (e) => {
      throw e;
    }
  );
  el.getURL = () => m.url;
  el.getTitle = () => m.title;
  el.isLoading = () => m.loading;
  el.canGoBack = () => m.canGoBack;
  el.canGoForward = () => m.canGoForward;
  el.goBack = () => fireAndForget("browser_guest_control", { lease, action: "back" });
  el.goForward = () => fireAndForget("browser_guest_control", { lease, action: "forward" });
  el.reload = () => fireAndForget("browser_guest_control", { lease, action: "reload" });
  el.clearHistory = () => {
  };
  el.stop = () => {
  };
}
function rectsIntersect(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function isWebviewTag(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node;
  return el.tagName.toLowerCase() === "webview" && el.dataset?.sidebarBrowserFrame === "webview" && typeof el.getAttribute("name") === "string";
}
function installTagObserver() {
  const bind = (el) => {
    const lease = el.getAttribute("name");
    const m = mirrorOf(lease);
    if (m.el === el) return;
    m.el = el;
    patchElement(el, lease, m);
    const applyRect = () => {
      m.rectPending = false;
      const r = el.getBoundingClientRect();
      const rectVisible = r.width > 1 && r.height > 1;
      const shouldShow = rectVisible && !m.overlayHidden;
      if (rectVisible) {
        void invoke3("browser_guest_set_bounds", {
          lease,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height
        }).catch(() => {
        });
      }
      if (shouldShow !== m.shown) {
        m.shown = shouldShow;
        void invoke3("browser_guest_set_visible", { lease, visible: shouldShow }).catch(() => {
        });
      }
    };
    const scheduleRect = () => {
      if (m.rectPending) return;
      m.rectPending = true;
      requestAnimationFrame(applyRect);
    };
    rectSchedulers.set(lease, scheduleRect);
    ensureRectPoll();
    const recomputeOverlay = () => {
      const el2 = m.el;
      if (!el2) return;
      let hidden = false;
      const r = el2.getBoundingClientRect();
      for (const dlg of document.querySelectorAll("[role=dialog]")) {
        const dr = dlg.getBoundingClientRect();
        if (dr.width > 0 && rectsIntersect(r, dr)) {
          hidden = true;
          break;
        }
      }
      m.overlayHidden = hidden;
      scheduleRect();
    };
    const ro = new ResizeObserver(scheduleRect);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener("resize", scheduleRect);
    const dialogMo = new MutationObserver(recomputeOverlay);
    dialogMo.observe(document.body, { childList: true, subtree: true });
    void invoke3("browser_guest_state", { lease }).then((snap) => {
      m.url = snap.url;
      m.title = snap.title;
      m.loading = snap.loading;
      m.canGoBack = snap.canGoBack;
      m.canGoForward = snap.canGoForward;
    }).catch(() => {
    }).finally(() => {
      scheduleRect();
      recomputeOverlay();
      el.dispatchEvent(makeEvent("dom-ready"));
    });
  };
  const mo = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && isWebviewTag(node)) bind(node);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
function installDesktopBrowserBridge() {
  const g = globalThis;
  if (!g.dshDesktop || g.__dshShellBridgeImpl) return;
  const impl = {
    acquire(workspace) {
      const key = typeof workspace === "string" ? workspace : String(workspace ?? "");
      return invoke3("browser_guest_acquire", { workspaceKey: key }).then(
        (res) => {
          mirrorOf(res.lease);
          return res;
        }
      );
    },
    release(lease) {
      const m = mirrors.get(lease);
      if (m) {
        m.el = void 0;
        m.shown = false;
        mirrors.delete(lease);
      }
      openListeners.delete(lease);
      return invoke3("browser_guest_release", { lease }).then(
        () => void 0,
        (e) => {
          console.error("[desktop-browser-bridge] guest release \u5931\u8D25", e);
        }
      );
    },
    onOpenRequested(lease, listener) {
      openListeners.set(lease, listener);
      return () => {
        if (openListeners.get(lease) === listener) openListeners.delete(lease);
      };
    },
    _receive(push) {
      applyPush(push);
    },
    _openRequested(payload) {
      openListeners.get(payload.lease)?.(payload.url);
    }
  };
  g.__dshShellBridgeImpl = impl;
  installTagObserver();
  window.addEventListener("pagehide", () => {
    void invoke3("browser_guest_release_all", {}).catch(() => {
    });
  });
}

// src/client/desktop-settings.tsx
var import_react3 = __toESM(require("react"), 1);

// src/client/theme-select.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var TRIGGER_STYLE = {
  minWidth: 0,
  width: "100%",
  height: 28,
  color: "var(--dsw-alias-label-secondary)",
  cursor: "pointer",
  background: "transparent",
  border: "none",
  borderRadius: 24,
  outline: "none",
  alignItems: "center",
  gap: 4,
  padding: "0 4px 0 8px",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
  display: "flex"
};
var MENU_STYLE = {
  zIndex: 1100,
  background: "var(--dsw-specific-menu)",
  boxShadow: "var(--dsw-elevation-prominent)",
  color: "var(--dsw-alias-label-primary)",
  minWidth: "min(240px, 100%)",
  maxHeight: "min(360px, 60vh)",
  borderRadius: 20,
  padding: 4,
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  overflowY: "auto",
  overflowX: "hidden"
};
var OPTION_BASE = {
  boxSizing: "border-box",
  width: "100%",
  minHeight: 38,
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  background: "transparent",
  border: "none",
  borderRadius: 10,
  outline: "none",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  display: "flex",
  fontSize: 13
};
function ThemeSelect({ value, options, onChange, placeholder, style, disabled }) {
  const [open, setOpen] = (0, import_react2.useState)(false);
  const rootRef = (0, import_react2.useRef)(null);
  const listRef = (0, import_react2.useRef)(null);
  (0, import_react2.useEffect)(() => {
    if (!open) return;
    const onDown = (ev) => {
      if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  (0, import_react2.useEffect)(() => {
    if (!open || !listRef.current) return;
    const sel = listRef.current.querySelector('[data-selected="1"]');
    sel?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const pick = (0, import_react2.useCallback)(
    (v) => {
      setOpen(false);
      if (v !== value) onChange(v);
    },
    [onChange, value]
  );
  const onMenuKey = (0, import_react2.useCallback)(
    (ev) => {
      const idx = options.findIndex((o) => o.value === value);
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        const next = options[Math.min(idx + 1, options.length - 1)];
        if (next) onChange(next.value);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        const next = options[Math.max(idx - 1, 0)];
        if (next) onChange(next.value);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (value) onChange(value);
      }
    },
    [options, onChange, value]
  );
  const current = options.find((o) => o.value === value);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { ref: rootRef, style: { minWidth: 0, position: "relative", ...style ?? {} }, onKeyDown: onMenuKey, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "button",
      {
        type: "button",
        "data-theme-select-trigger": "1",
        disabled,
        onClick: () => setOpen((v) => !v),
        style: { ...TRIGGER_STYLE, opacity: disabled ? 0.5 : 1 },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              style: {
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                overflow: "hidden",
                flex: 1,
                textAlign: "left"
              },
              children: current?.label ?? placeholder ?? ""
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              style: {
                color: "var(--dsw-alias-label-caption)",
                flex: "none",
                transition: "transform .12s",
                transform: open ? "rotate(180deg)" : void 0
              },
              children: "\u25BE"
            }
          )
        ]
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { ref: listRef, style: MENU_STYLE, role: "listbox", children: [
      options.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { color: "var(--dsw-alias-label-tertiary)", padding: 10, fontSize: 13, lineHeight: "20px" }, children: "\u65E0\u9009\u9879" }),
      options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          "data-theme-select-option": "1",
          "data-selected": o.value === value ? "1" : void 0,
          onClick: () => {
            setOpen(false);
            onChange(o.value);
          },
          style: {
            ...OPTION_BASE,
            background: o.value === value ? "var(--dsw-alias-interactive-bg-hover)" : "transparent"
          },
          children: o.label
        },
        o.value
      ))
    ] })
  ] });
}

// src/client/desktop-settings.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var nsRpc = null;
function hasIpc3() {
  const w = window;
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}
function invoke4(cmd, args) {
  const w = window;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args);
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args);
  return Promise.reject(new Error("no tauri ipc"));
}
var PANEL_CSS = `
[data-desktop-settings] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s; }
[data-desktop-settings] .pf-btn:hover { filter:brightness(1.12); }
[data-desktop-settings] .pf-btn:active { transform:translateY(1px); }
[data-desktop-settings] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-desktop-settings] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-desktop-settings] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-desktop-settings] .pf-btn.danger { background:transparent; border:1px solid var(--dsw-alias-state-danger-primary,#e5534b); color:var(--dsw-alias-state-danger-primary,#e5534b); }
[data-desktop-settings] .pf-btn.danger:hover { background:rgba(229,83,75,.12); filter:none; }
[data-desktop-settings] .pf-btn:disabled { opacity:.5; cursor:not-allowed; }
[data-desktop-settings] input, [data-desktop-settings] select { padding:6px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l,#ffffff1f); background:var(--dsw-alias-bg-base,#151517); color:inherit; font-size:12px; }
[data-desktop-settings] .pf-label { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-bottom:4px; }
[data-desktop-settings] .pf-input { width:100%; box-sizing:border-box; }
[data-desktop-settings] .pf-title { font-weight:600; font-size:13px; margin-bottom:10px; }
[data-desktop-settings] .pf-row { display:flex; gap:8px; align-items:center; }
[data-desktop-settings] .pf-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; word-break:break-all; }
`;
var stylesInstalled = false;
function ensureStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.dataset.desktopSettings = "styles";
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}
var ROOT_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  maxWidth: 680,
  fontSize: 13
};
var SECTION_STYLE = {
  border: "1px solid var(--dsw-alias-border-l,#ffffff1f)",
  borderRadius: 12,
  padding: "14px 16px"
};
var TITLE_STYLE = {
  fontWeight: 600,
  fontSize: 13,
  marginBottom: 10
};
var LABEL_STYLE = {
  fontSize: 11,
  color: "var(--dsw-alias-label-secondary,#9aa4b2)",
  marginBottom: 4
};
var NOTE_STYLE = {
  fontSize: 11,
  color: "var(--dsw-alias-label-secondary,#9aa4b2)",
  marginTop: 8,
  wordBreak: "break-all"
};
var INPUT_BASE_STYLE = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid var(--dsw-alias-border-l,#ffffff1f)",
  background: "var(--dsw-alias-bg-base,#151517)",
  color: "inherit",
  fontSize: 12
};
var INPUT_FULL_STYLE = { ...INPUT_BASE_STYLE, width: "100%", boxSizing: "border-box" };
var ROW_STYLE = { display: "flex", gap: 8, alignItems: "center" };
var FLEX_1_STYLE = { flex: 1 };
var BTN_PRIMARY_STYLE = {
  background: "var(--dsw-alias-brand-primary-new-color,#4176e6)",
  border: "none",
  color: "#fff",
  borderRadius: 8,
  padding: "6px 13px",
  fontSize: 12,
  cursor: "pointer"
};
var BTN_GHOST_STYLE = {
  ...BTN_PRIMARY_STYLE,
  background: "transparent",
  border: "1px solid var(--dsw-alias-border-l,#ffffff1f)",
  color: "var(--dsw-alias-label-primary,#e7eaf0)"
};
var BTN_DANGER_STYLE = {
  ...BTN_PRIMARY_STYLE,
  background: "transparent",
  border: "1px solid var(--dsw-alias-state-danger-primary,#e5534b)",
  color: "var(--dsw-alias-state-danger-primary,#e5534b)"
};
var DANGER_NOTE_STYLE = {
  ...NOTE_STYLE,
  color: "var(--dsw-alias-state-danger-primary,#e5534b)"
};
async function nsSave(patch) {
  await invoke4("save_desktop_settings", { patch });
}
async function nsGet() {
  const d = await invoke4("get_desktop_settings_data");
  return d.settings && typeof d.settings === "object" ? d.settings : {};
}
function normalizeRemote(input) {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//.test(t)) return t;
  if (/^socks5:\/\//.test(t)) return t;
  if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(t)) return `https://${t}`;
  return null;
}
function SectionBox({ title, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: SECTION_STYLE, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: TITLE_STYLE, children: title }),
    children
  ] });
}
function PfBtn({
  variant = "primary",
  disabled = false,
  onClick,
  children,
  style,
  title
}) {
  const baseStyle = variant === "primary" ? BTN_PRIMARY_STYLE : variant === "ghost" ? BTN_GHOST_STYLE : BTN_DANGER_STYLE;
  const cls = variant === "primary" ? "pf-btn" : `pf-btn ${variant}`;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    "button",
    {
      type: "button",
      className: cls,
      disabled,
      title,
      onClick,
      style: { ...baseStyle, ...style ?? {} },
      children
    }
  );
}
function showToast(text, ok) {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:500;max-width:480px;box-shadow:0 4px 12px rgba(0,0,0,.4);cursor:pointer;backdrop-filter:blur(8px);${ok ? "background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.6);color:#4ade80" : "background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.6);color:#f87171"}`;
  el.textContent = text;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  if (ok) window.setTimeout(() => el.remove(), 5e3);
}
function DesktopSettingsPanel() {
  const [proxy, setProxy] = (0, import_react3.useState)({
    proxy_mode: "off",
    proxy_url: "",
    no_proxy: "",
    proxy_user: "",
    proxy_pass: ""
  });
  const [proxyEffective, setProxyEffective] = (0, import_react3.useState)(void 0);
  const [desktop, setDesktop] = (0, import_react3.useState)({
    remote_addr: null,
    remote_list: [],
    port: 3080,
    profiles: []
  });
  const [msg, setMsg] = (0, import_react3.useState)(null);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  (0, import_react3.useEffect)(() => {
    if (msg && msg.ok) {
      const t = window.setTimeout(() => setMsg(null), 4e3);
      return () => window.clearTimeout(t);
    }
  }, [msg]);
  const [sourceState, setSourceState] = (0, import_react3.useState)(null);
  const [sourceError, setSourceError] = (0, import_react3.useState)(null);
  const [newRemoteUrl, setNewRemoteUrl] = (0, import_react3.useState)("");
  const [concurrencyInput, setConcurrencyInput] = (0, import_react3.useState)("3");
  const concurrencyTouchedRef = (0, import_react3.useRef)(false);
  const [testResult, setTestResult] = (0, import_react3.useState)(null);
  const [testBusy, setTestBusy] = (0, import_react3.useState)(false);
  const [profilePorts, setProfilePorts] = (0, import_react3.useState)([]);
  const [profilePortsStatus, setProfilePortsStatus] = (0, import_react3.useState)({ state: "loading", text: "\u52A0\u8F7D\u4E2D\u2026" });
  const [profilePortInputs, setProfilePortInputs] = (0, import_react3.useState)({});
  const [profilePortBoxNote, setProfilePortBoxNote] = (0, import_react3.useState)(null);
  const [migrationSource, setMigrationSource] = (0, import_react3.useState)("");
  const [migrationDest, setMigrationDest] = (0, import_react3.useState)("");
  const [migrationRunning, setMigrationRunning] = (0, import_react3.useState)(false);
  const [migrationProgress, setMigrationProgress] = (0, import_react3.useState)(null);
  const [runtimeSource, setRuntimeSource] = (0, import_react3.useState)("github");
  const [runtimeStatus, setRuntimeStatus] = (0, import_react3.useState)({ state: "loading", text: "\u8BFB\u53D6\u4E2D\u2026" });
  const [runtimeCatalog, setRuntimeCatalog] = (0, import_react3.useState)(null);
  const [runtimeDownloading, setRuntimeDownloading] = (0, import_react3.useState)({});
  const [depProfiles, setDepProfiles] = (0, import_react3.useState)(null);
  const [depRebuilding, setDepRebuilding] = (0, import_react3.useState)(null);
  const [depNote, setDepNote] = (0, import_react3.useState)("");
  const [depError, setDepError] = (0, import_react3.useState)(null);
  const refreshDepStatus = (0, import_react3.useCallback)(async () => {
    try {
      const r = await invoke4("list_profile_dependency_status");
      setDepProfiles(r?.profiles ?? []);
    } catch (err) {
      console.error("[desktop-settings] list_profile_dependency_status \u5931\u8D25\uFF1A", err);
      setDepError(String(err));
      setDepProfiles(null);
    }
  }, []);
  import_react3.default.useEffect(() => {
    void refreshDepStatus();
  }, [refreshDepStatus]);
  const handleRebuildDeps = (profile) => {
    if (depRebuilding) return;
    setDepRebuilding(profile);
    setDepNote(`${profile}\uFF1A\u4F9D\u8D56\u91CD\u5EFA\u4E2D\uFF08\u7528\u5185\u7F6E pnpm \u91CD\u88C5\uFF0C\u53EF\u80FD\u9700\u8981\u51E0\u5206\u949F\uFF09\u2026`);
    void invoke4("rebuild_profile_dependencies", { profile }).then(() => {
      setDepNote(`${profile}\uFF1A\u4F9D\u8D56\u5DF2\u91CD\u5EFA\uFF0C\u91CD\u542F\u8BE5 profile \u540E\u751F\u6548\u3002`);
      return refreshDepStatus();
    }).catch((err) => setDepNote(`${profile}\uFF1A\u91CD\u5EFA\u5931\u8D25 \u2014\u2014 ${String(err)}`)).finally(() => setDepRebuilding(null));
  };
  const [removingVersion, setRemovingVersion] = (0, import_react3.useState)(null);
  const [dlProgress, setDlProgress] = (0, import_react3.useState)(null);
  const [runtimeExpanded, setRuntimeExpanded] = (0, import_react3.useState)(false);
  const [downloadBoxNote, setDownloadBoxNote] = (0, import_react3.useState)(null);
  const [taskInfo, setTaskInfo] = (0, import_react3.useState)(null);
  (0, import_react3.useEffect)(() => {
    const timer = setInterval(() => {
      void invoke4("task_status").then((t) => {
        if (t.running || t.finished) setTaskInfo(t);
      }).catch(() => {
      });
    }, 600);
    return () => clearInterval(timer);
  }, []);
  (0, import_react3.useEffect)(() => {
    ensureStyles();
  }, []);
  (0, import_react3.useEffect)(() => {
    void invoke4("runtime_download_status").then((s) => {
      if (s.active && s.version) {
        setRuntimeDownloading((prev) => ({ ...prev, [s.version]: "downloading" }));
      }
    }).catch(() => {
    });
  }, []);
  (0, import_react3.useEffect)(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ns, p, d] = await Promise.all([
          nsGet(),
          invoke4("get_proxy_settings"),
          invoke4("get_desktop_settings_data")
        ]);
        if (cancelled) return;
        setProxy({
          proxy_mode: ns.proxy_mode || p.proxy_mode || "off",
          proxy_url: ns.proxy_url || p.proxy_url || "",
          no_proxy: ns.no_proxy || p.no_proxy || "",
          proxy_user: ns.proxy_user || p.proxy_user || "",
          proxy_pass: ns.proxy_pass || p.proxy_pass || ""
        });
        setProxyEffective(p.effective);
        setDesktop({
          remote_addr: ns.remote_addr ?? null,
          remote_list: ns.remote_list ?? d.remote_list ?? [],
          port: ns.port || d.port || 3080,
          profiles: d.profiles
        });
        if (d.profiles.length > 0) {
          const first = d.profiles[0];
          if (first) {
            setMigrationSource(first.name);
            const other = d.profiles.find((pp) => pp.name !== first.name);
            if (other) setMigrationDest(other.name);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setMsg({ ok: false, text: `\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const refreshSource = (0, import_react3.useCallback)(async () => {
    setSourceError(null);
    try {
      const s = await invoke4("get_dsh_source");
      setSourceState(s);
    } catch (err) {
      setSourceError(String(err));
    }
  }, []);
  (0, import_react3.useEffect)(() => {
    void refreshSource();
  }, [refreshSource]);
  (0, import_react3.useEffect)(() => {
    invoke4("get_download_settings").then((s) => {
      if (!concurrencyTouchedRef.current) setConcurrencyInput(String(s.concurrency));
    }).catch(() => {
    });
  }, []);
  (0, import_react3.useEffect)(() => {
    let cancelled = false;
    let attempt = 0;
    const load = () => {
      invoke4("list_profile_ports").then((rows) => {
        if (cancelled) return;
        setProfilePorts(rows);
        setProfilePortsStatus({ state: "ok" });
      }).catch((err) => {
        if (cancelled) return;
        if (attempt < 2) {
          attempt += 1;
          setProfilePortsStatus({ state: "loading", text: `\u52A0\u8F7D\u5931\u8D25\uFF0C\u91CD\u8BD5\u4E2D\uFF08${attempt}/2\uFF09\u2026` });
          window.setTimeout(load, 800);
        } else {
          setProfilePortsStatus({
            state: "error",
            text: `\u7AEF\u53E3\u8868\u52A0\u8F7D\u5931\u8D25\uFF1A${String(err)}\uFF08\u8BF7\u91CD\u542F dsh \u540E\u91CD\u8BD5\uFF09`
          });
        }
      });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);
  const refreshRuntimes = (0, import_react3.useCallback)(async () => {
    setRuntimeStatus({ state: "loading", text: "\u8BFB\u53D6\u7248\u672C\u76EE\u5F55\u4E2D\u2026" });
    try {
      const s = await invoke4("list_runtime_catalog", { source: runtimeSource });
      setRuntimeCatalog(s);
      setRuntimeStatus(
        s.error ? { state: "error", text: `\u76EE\u5F55\u62C9\u53D6\u5931\u8D25\uFF1A${s.error}\uFF08\u4EC5\u663E\u793A\u5DF2\u4E0B\u8F7D\u7248\u672C\uFF09` } : { state: "ok" }
      );
      setRuntimeDownloading({});
    } catch (err) {
      setRuntimeStatus({ state: "error", text: `\u7248\u672C\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A${String(err)}` });
    }
  }, [runtimeSource]);
  (0, import_react3.useEffect)(() => {
    void refreshRuntimes();
  }, [refreshRuntimes]);
  (0, import_react3.useEffect)(() => {
    if (!migrationRunning) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await invoke4("migration_status");
        if (cancelled) return;
        if (st.running) {
          setMigrationProgress({ copied: st.copied, total: st.total });
          window.setTimeout(tick, 300);
        } else {
          window.setTimeout(tick, 300);
        }
      } catch {
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [migrationRunning]);
  const handleSourceModeChange = (value) => {
    void nsSave({ dsh_mode: value }).then(() => invoke4("restart_dsh_service")).then(
      () => setMsg({ ok: true, text: `dsh \u6765\u6E90\u5DF2\u5207\u6362\u4E3A ${value === "builtin" ? "\u5185\u7F6E" : "\u5916\u90E8"}\uFF0C\u6B63\u5728\u91CD\u542F\u2026` })
    ).catch((err) => {
      console.error("[desktop-settings] set_dsh_source/restart \u5931\u8D25\uFF1A", err);
      setMsg({ ok: false, text: `\u5207\u6362\u5931\u8D25\uFF1A${String(err)}` });
    });
  };
  const handleSelectRemote = (addr) => {
    void (async () => {
      try {
        await nsSave({ remote_addr: addr });
        await invoke4("restart_dsh_service");
        setMsg({ ok: true, text: "\u5DF2\u5207\u6362 dsh \u670D\u52A1\u6765\u6E90\uFF0C\u6B63\u5728\u91CD\u542F\u2026" });
      } catch (err) {
        setMsg({ ok: false, text: `\u5207\u6362\u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
  };
  const handleAddRemote = () => {
    const addr = normalizeRemote(newRemoteUrl);
    if (!addr) {
      setMsg({ ok: false, text: "\u5730\u5740\u975E\u6CD5\uFF1A\u9700 dsh web \u5B8C\u6574 URL\uFF08\u542B token\uFF09\u6216 host[:port]" });
      return;
    }
    void (async () => {
      try {
        const list = Array.isArray(desktop.remote_list) ? [...desktop.remote_list] : [];
        if (!list.includes(addr)) list.push(addr);
        await nsSave({ remote_list: list });
        setNewRemoteUrl("");
        setMsg({ ok: true, text: `\u5DF2\u65B0\u589E\u5730\u5740\uFF1A${addr}\uFF08\u672A\u5207\u6362\uFF0C\u8BF7\u5728\u4E0B\u62C9\u6846\u9009\u62E9\uFF09` });
        await refreshData();
      } catch (err) {
        setMsg({ ok: false, text: `\u65B0\u589E\u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
  };
  const handleRemoveRemote = (addr) => {
    void (async () => {
      try {
        const list = (desktop.remote_list ?? []).filter((a) => a !== addr);
        const patch = { remote_list: list };
        if (desktop.remote_addr === addr) patch.remote_addr = null;
        await nsSave(patch);
        setMsg({ ok: true, text: `\u5DF2\u5220\u9664\uFF1A${addr}` });
      } catch (err) {
        setMsg({ ok: false, text: `\u5220\u9664\u5931\u8D25\uFF1A${String(err)}` });
      }
      await refreshData();
    })();
  };
  const handleSwitchProfile = (name) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      setMsg({ ok: false, text: "Profile \u540D\u4E0D\u5408\u6CD5" });
      return;
    }
    void (async () => {
      try {
        await nsSave({ active_profile: name });
        await invoke4("restart_dsh_service");
        setMsg({ ok: true, text: `\u5DF2\u5207\u6362\u5230 Profile\u300C${name}\u300D\uFF0C\u6B63\u5728\u91CD\u542F\u2026` });
      } catch (err) {
        setMsg({ ok: false, text: `\u5207\u6362 Profile \u5931\u8D25\uFF1A${String(err)}` });
      }
    })();
  };
  const handleSaveProfilePort = (profile) => {
    const raw = profilePortInputs[profile] ?? "";
    const v = Number(raw);
    if (!raw || Number.isNaN(v) || v < 1 || v > 65535) return;
    void nsSave({ [`profile_ports.${profile}`]: v }).then(() => setProfilePortBoxNote(`${profile} \u7AEF\u53E3\u5DF2\u6539\u4E3A ${v}\uFF1B\u91CD\u542F\u8BE5 profile \u751F\u6548\u3002`)).catch((e) => setProfilePortBoxNote(`\u4FDD\u5B58\u5931\u8D25\uFF1A${String(e)}`));
  };
  const handleSaveConcurrency = () => {
    const v = Math.max(1, Math.min(32, parseInt(concurrencyInput, 10) || 3));
    void nsSave({ download_concurrency: v }).then(() => invoke4("set_download_concurrency", { value: v })).then(() => setDownloadBoxNote(`\u5DF2\u4FDD\u5B58\uFF1A\u5E76\u53D1\u4E0A\u9650 ${v}`)).catch(() => setDownloadBoxNote("\u4FDD\u5B58\u5931\u8D25\uFF08\u65E0 Tauri IPC\uFF1F\uFF09"));
  };
  const handleSaveProxy = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        await nsSave({
          proxy_mode: proxy.proxy_mode,
          proxy_url: proxy.proxy_url,
          no_proxy: proxy.no_proxy,
          proxy_user: proxy.proxy_user,
          proxy_pass: proxy.proxy_pass
        });
        setMsg({ ok: true, text: "\u4EE3\u7406\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF1B\u4E0B\u6B21 dsh \u91CD\u542F\u540E\u751F\u6548\u3002" });
      } catch (err) {
        setMsg({ ok: false, text: `\u4FDD\u5B58\u5931\u8D25\uFF1A${String(err)}` });
      } finally {
        setBusy(false);
      }
    })();
  };
  const handleTestProxy = () => {
    if (testBusy) return;
    setTestBusy(true);
    setTestResult(null);
    void (async () => {
      try {
        const ms = await invoke4("test_proxy_connectivity", { url: proxy.proxy_url });
        setTestResult(`\u8FDE\u63A5\u6210\u529F\uFF08${ms}ms\uFF09`);
      } catch (err) {
        setTestResult(`\u8FDE\u63A5\u5931\u8D25\uFF1A${String(err)}`);
      } finally {
        setTestBusy(false);
      }
    })();
  };
  const handleMigrate = () => {
    if (!migrationDest) {
      setMsg({ ok: false, text: "\u6CA1\u6709\u53EF\u9009\u7684\u76EE\u6807 profile\uFF08\u8BF7\u5148\u65B0\u5EFA\u4E00\u4E2A\uFF09" });
      return;
    }
    const start = (overwrite) => {
      setMigrationRunning(true);
      setMigrationProgress({ copied: 0, total: 0 });
      invoke4("migrate_profile", {
        source: migrationSource,
        dest: migrationDest,
        overwrite
      }).then((s) => {
        setMigrationRunning(false);
        setMigrationProgress(null);
        showToast(s, true);
      }).catch((e) => {
        const m = String(e);
        if (!overwrite && m.includes("\u9700\u786E\u8BA4\u8986\u76D6")) {
          console.error("[migrate] \u9700\u786E\u8BA4\u8986\u76D6\uFF0C\u91CD\u8BD5 overwrite=true");
          start(true);
          return;
        }
        setMigrationRunning(false);
        setMigrationProgress(null);
        console.error("[migrate] \u5931\u8D25\uFF1A", m);
        showToast(`\u8FC1\u79FB\u5931\u8D25\uFF1A${m}`, false);
      });
    };
    start(false);
  };
  const handleDownloadRuntime = (version) => {
    setRuntimeDownloading((prev) => ({ ...prev, [version]: "downloading" }));
    void invoke4("download_runtime", { source: runtimeSource, version }).then(() => {
      setRuntimeDownloading((prev) => ({ ...prev, [version]: "downloaded" }));
      void refreshRuntimes();
      showToast(`dsh ${version} \u4E0B\u8F7D\u5B8C\u6210`, true);
    }).catch((err) => {
      const text = String(err);
      if (text.includes("\u5DF2\u6709\u8FD0\u884C\u65F6\u4E0B\u8F7D\u4EFB\u52A1")) {
        setRuntimeDownloading((prev) => {
          const next = { ...prev };
          delete next[version];
          return next;
        });
        return;
      }
      const reason = text.replace(/^下载失败：?/i, "");
      setRuntimeDownloading((prev) => ({ ...prev, [version]: { failed: reason || "\u672A\u77E5\u9519\u8BEF" } }));
      showToast(`dsh ${version} \u4E0B\u8F7D\u5931\u8D25\uFF1A${reason || "\u672A\u77E5\u9519\u8BEF"}`, false);
    });
  };
  (0, import_react3.useEffect)(() => {
    let sawActive = false;
    const timer = setInterval(() => {
      void invoke4("runtime_download_status").then((s) => {
        if (s.active) {
          sawActive = true;
          setRuntimeDownloading(
            (prev) => prev[s.version] === "downloading" ? prev : { ...prev, [s.version]: "downloading" }
          );
          setDlProgress({ version: s.version, resolved: s.resolved, downloaded: s.downloaded, added: s.added });
          return;
        }
        setDlProgress(null);
        if (!sawActive) return;
        sawActive = false;
        const ok = !s.error;
        setRuntimeDownloading((prev) => {
          const next = { ...prev };
          delete next[s.version];
          return next;
        });
        void refreshRuntimes();
        showToast(
          ok ? `dsh ${s.version} \u4E0B\u8F7D\u5B8C\u6210` : `dsh ${s.version} \u4E0B\u8F7D\u5931\u8D25\uFF1A${s.error.replace(/^下载失败：?/i, "")}`,
          ok
        );
      }).catch(() => {
      });
    }, 600);
    return () => clearInterval(timer);
  }, [refreshRuntimes]);
  const handleSwitchRuntime = (version) => {
    const isBuiltin = runtimeCatalog?.builtin === version;
    void nsSave({ dsh_runtime: isBuiltin ? null : version, dsh_mode: "builtin" }).then(() => invoke4("restart_dsh_service")).then(() => {
      setMsg({ ok: true, text: `\u5DF2\u5207\u6362\u5230 dsh ${version}\uFF0C\u6B63\u5728\u91CD\u542F\u2026` });
      void refreshRuntimes();
    }).catch((err) => setMsg({ ok: false, text: `\u5207\u6362\u5931\u8D25\uFF1A${String(err)}` }));
  };
  const handleRemoveRuntime = (version) => {
    if (removingVersion) return;
    if (!window.confirm(`\u5378\u8F7D\u8FD0\u884C\u65F6 dsh ${version}\uFF1F\u5C06\u5220\u9664\u672C\u5730\u5DF2\u4E0B\u8F7D\u6587\u4EF6\uFF0C\u4E0D\u53EF\u6062\u590D\u3002`)) return;
    setRemovingVersion(version);
    invoke4("remove_runtime", { version }).then(() => {
      setMsg({ ok: true, text: `\u5DF2\u5378\u8F7D\u8FD0\u884C\u65F6 dsh ${version}` });
      void refreshRuntimes();
    }).catch((err) => setMsg({ ok: false, text: `\u5378\u8F7D\u5931\u8D25\uFF1A${String(err)}` })).finally(() => setRemovingVersion(null));
  };
  const refreshData = (0, import_react3.useCallback)(async () => {
    try {
      const d = await invoke4("get_desktop_settings_data");
      setDesktop(d);
    } catch {
    }
  }, []);
  const sourceModeValue = sourceState ? sourceState.running ? sourceState.running.mode : sourceState.mode : "builtin";
  const sourceInfoText = (() => {
    if (!sourceState) return "";
    const parts = [];
    if (sourceState.running) {
      const runVer = sourceState.running.version || (sourceState.running.mode === "builtin" ? sourceState.builtin?.dsh_version ?? "" : sourceState.external?.dsh_version ?? "");
      const origin = sourceState.running.origin === "shell" ? "\u672C\u58F3 spawn" : "\u590D\u7528\u63A5\u5165";
      parts.push(
        `\u5F53\u524D\u8FD0\u884C\uFF1A${sourceState.running.mode === "builtin" ? "\u5185\u7F6E" : "\u5916\u90E8"} dsh ${runVer}\uFF08${origin} \xB7 port ${sourceState.running.port}\uFF09`
      );
    } else {
      parts.push("\u5F53\u524D\u65E0\u8FD0\u884C\u4E2D\u7684 dsh \u5B9E\u4F8B\uFF1B\u4E0B\u6B21\u542F\u52A8\u5C06\u4F7F\u7528\u4E0B\u65B9\u6240\u9009\u6765\u6E90");
    }
    if (sourceState.builtin) parts.push(`\u5185\u7F6E\u53EF\u7528\uFF1Adsh ${sourceState.builtin.dsh_version}`);
    if (sourceState.external) parts.push(`\u5916\u90E8\u53EF\u7528\uFF1Adsh ${sourceState.external.dsh_version}\uFF08${sourceState.external.path}\uFF09`);
    return parts.join(" \xB7 ");
  })();
  const migrationDestOptions = desktop.profiles.filter((p) => p.name !== migrationSource);
  const activeProfile = desktop.profiles.find((p) => p.active);
  const profileSelectValue = activeProfile?.name ?? desktop.profiles[0]?.name ?? "";
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { "data-desktop-settings": "", style: ROOT_STYLE, children: [
    taskInfo && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
      "div",
      {
        style: {
          padding: "8px 12px",
          borderRadius: 8,
          marginBottom: 10,
          fontSize: 12,
          background: "var(--dsw-alias-bg-base,#16181d)",
          border: taskInfo.finished ? taskInfo.error ? "1px solid rgba(239,68,68,.6)" : "1px solid rgba(34,197,94,.5)" : "1px solid var(--dsw-alias-border-neutral,#2a2e37)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: [
            taskInfo.running ? "\u23F3 " : taskInfo.error ? "\u2717 " : "\u2713 ",
            taskInfo.title
          ] }),
          taskInfo.running && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { opacity: 0.8 }, children: taskInfo.stage || "\u51C6\u5907\u4E2D\u2026" }),
            taskInfo.total > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "div",
                {
                  style: {
                    height: 5,
                    borderRadius: 3,
                    marginTop: 6,
                    overflow: "hidden",
                    background: "rgba(127,127,127,.25)"
                  },
                  children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                    "div",
                    {
                      style: {
                        height: "100%",
                        width: `${Math.min(100, Math.round(taskInfo.done / taskInfo.total * 100))}%`,
                        background: "var(--dsw-alias-state-accent-primary,#3b82f6)",
                        transition: "width .3s"
                      }
                    }
                  )
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { opacity: 0.6, marginTop: 3 }, children: [
                taskInfo.done,
                "/",
                taskInfo.total
              ] })
            ] })
          ] }),
          taskInfo.finished && taskInfo.error && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { color: "#f87171", whiteSpace: "pre-wrap" }, children: taskInfo.error }),
          taskInfo.finished && !taskInfo.error && taskInfo.result && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { opacity: 0.85 }, children: taskInfo.result })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "dsh \u6765\u6E90\uFF08\u5185\u7F6E / \u5916\u90E8\uFF09", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        ThemeSelect,
        {
          style: { marginBottom: 8 },
          value: sourceModeValue,
          onChange: handleSourceModeChange,
          options: [
            { value: "builtin", label: "\u5185\u7F6E\uFF08\u968F\u5E94\u7528\u5206\u53D1\uFF0C\u63A8\u8350\uFF09" },
            { value: "external", label: "\u5916\u90E8\uFF08DSH_BIN \u2192 PATH \u2192 npm \u5168\u5C40\uFF09" }
          ]
        }
      ),
      sourceState ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: sourceInfoText }) : sourceError ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: DANGER_NOTE_STYLE, children: [
        "\u68C0\u6D4B\u5931\u8D25\uFF1A",
        sourceError
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u68C0\u6D4B\u4E2D\u2026" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { marginTop: 8 }, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", onClick: () => void refreshSource(), children: "\u91CD\u65B0\u68C0\u6D4B" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u5185\u7F6E\uFF1A\u968F\u5E94\u7528\u5206\u53D1\u7684 dsh \u4F9D\u8D56\u6811 + Node\uFF0C\u76F4\u8C03\u5185\u90E8\u542F\u52A8\u63A5\u53E3\uFF08\u4E0D\u4F9D\u8D56\u7CFB\u7EDF\u73AF\u5883\uFF09\u3002\u5916\u90E8\uFF1A\u4F7F\u7528\u7CFB\u7EDF\u5B89\u88C5\u7684 dsh CLI\u3002\u5207\u6362\u540E\u7ACB\u5373\u91CD\u542F dsh\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "dsh \u670D\u52A1\u5730\u5740", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        ThemeSelect,
        {
          style: { marginBottom: 8 },
          value: desktop.remote_addr ?? "",
          onChange: (v) => handleSelectRemote(v || null),
          options: [
            { value: "", label: "\u672C\u5730\uFF08127.0.0.1\uFF09" },
            ...(desktop.remote_list ?? []).map((addr) => ({ value: addr, label: addr }))
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: ROW_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            placeholder: "\u65B0\u589E\uFF1Adsh web \u6253\u5370\u7684\u5B8C\u6574 URL\uFF08\u542B token\uFF09\u6216 host[:port]",
            className: "pf-input",
            style: FLEX_1_STYLE,
            "data-desktop-settings": "remote-add",
            value: newRemoteUrl,
            onChange: (e) => setNewRemoteUrl(e.target.value.trim())
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", onClick: handleAddRemote, children: "\u65B0\u589E" })
      ] }),
      desktop.remote_list.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }, children: desktop.remote_list.map((addr) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        PfBtn,
        {
          variant: "danger",
          style: { fontSize: 11 },
          onClick: () => handleRemoveRemote(addr),
          children: [
            "\u5220\u9664\uFF1A",
            addr
          ]
        },
        addr
      )) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u9009\u62E9\u8FDC\u7A0B\u5730\u5740\u540E\u7ACB\u5373\u6309\u5F53\u524D\u6A21\u5F0F\u91CD\u542F dsh\uFF1B\u65B0\u589E/\u5220\u9664\u4EC5\u6539\u5217\u8868\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u6B64\u5904\u7684\u5730\u5740\u662F\u684C\u9762\u58F3\u8FDE\u63A5\u7684 dsh \u670D\u52A1\u6765\u6E90\uFF08\u58F3\u5C06\u76F4\u8FDE\u8BE5\u5730\u5740\uFF0C\u4E0D\u518D\u62C9\u8D77\u672C\u5730\u670D\u52A1\uFF09\uFF1B\u82E5\u8981\u7ED9\u624B\u673A/\u5176\u5B83\u8BBE\u5907\u8FDE\u63A5\u672C\u673A\uFF0C\u8BF7\u7528\u300C\u624B\u673A\u8BBF\u95EE \u2192 \u8FDC\u7A0B\u8BBF\u95EE\u300D\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "Profile", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        ThemeSelect,
        {
          style: { marginBottom: 8 },
          value: profileSelectValue,
          onChange: handleSwitchProfile,
          options: (desktop.profiles ?? []).map((p) => ({
            value: p.name,
            label: p.active ? `\u2713 ${p.name}` : p.name
          }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u5207\u6362 Profile \u4F1A\u4EE5\u76EE\u6807 profile \u91CD\u542F dsh web\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "Profile \u7AEF\u53E3", children: [
      profilePortsStatus.state === "ok" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("table", { style: { width: "100%", fontSize: 12, borderCollapse: "collapse" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tr", { children: ["Profile", "\u542F\u52A8\u7AEF\u53E3", "Lane \u7AEF\u53E3", "\u72B6\u6001", ""].map((h) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { textAlign: "left" }, children: h }, h)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tbody", { children: profilePorts.map((r) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { children: r.profile }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("td", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "input",
              {
                placeholder: String(r.port),
                style: { ...INPUT_BASE_STYLE, width: 84 },
                "data-desktop-settings": `profile-port-${r.profile}`,
                value: profilePortInputs[r.profile] ?? "",
                onChange: (e) => {
                  const v = e.target.value;
                  setProfilePortInputs((prev) => ({ ...prev, [r.profile]: v }));
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter") handleSaveProfilePort(r.profile);
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              PfBtn,
              {
                variant: "ghost",
                style: { marginLeft: 6 },
                onClick: () => handleSaveProfilePort(r.profile),
                children: "\u4FDD\u5B58"
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { children: r.lane_port }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "td",
            {
              style: {
                color: r.running ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-label-secondary,#9aa4b2)"
              },
              children: r.running ? "\u25CF \u8FD0\u884C\u4E2D" : "\u672A\u8FD0\u884C"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", {})
        ] }, r.profile)) })
      ] }) : profilePortsStatus.state === "error" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: DANGER_NOTE_STYLE, children: profilePortsStatus.text }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: profilePortsStatus.text ?? "\u52A0\u8F7D\u4E2D\u2026" }),
      profilePortBoxNote && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: profilePortBoxNote }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "web \u56FA\u5B9A\u9ED8\u8BA4 3080 \xB7 desktop \u56FA\u5B9A\u9ED8\u8BA4 3081 \xB7 \u5176\u4F59\u81EA\u52A8\u5206\u914D\uFF1Blane \u540C\u89C4\u5219\u9519\u5F00\uFF083092 \u8D77\uFF09\u3002\u6539\u52A8\u540E\u91CD\u542F\u8BE5 profile \u751F\u6548\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "\u8FC1\u79FB Profile", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "\u6E90 profile \u2192 \u76EE\u6807 profile\uFF08\u5168\u91CF\u590D\u5236\uFF1B\u76EE\u6807\u5DF2\u5B58\u5728\u9700\u8986\u76D6\u786E\u8BA4\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: ROW_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          ThemeSelect,
          {
            style: { flex: 1 },
            value: migrationSource,
            onChange: (v) => {
              setMigrationSource(v);
              const others = desktop.profiles.filter((p) => p.name !== v);
              const nextDest = others.find((p) => p.name === migrationDest) ?? others[0];
              if (nextDest) setMigrationDest(nextDest.name);
              else setMigrationDest("");
            },
            options: (desktop.profiles ?? []).map((p) => ({ value: p.name, label: p.name }))
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          ThemeSelect,
          {
            style: { flex: 1 },
            value: migrationDest,
            onChange: (v) => setMigrationDest(v),
            options: migrationDestOptions.map((p) => ({ value: p.name, label: p.name }))
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", onClick: handleMigrate, children: "\u8FC1\u79FB\u2026" })
      ] }),
      migrationRunning && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { marginTop: 10 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "div",
          {
            style: {
              height: 6,
              borderRadius: 4,
              background: "var(--dsw-alias-bg-base,#111)",
              overflow: "hidden"
            },
            children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "div",
              {
                style: {
                  height: "100%",
                  width: migrationProgress && migrationProgress.total > 0 ? `${Math.min(100, Math.round(migrationProgress.copied / migrationProgress.total * 100))}%` : "0%",
                  background: "var(--dsw-alias-state-accent-primary,#3b82f6)",
                  transition: "width .2s"
                }
              }
            )
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: migrationProgress ? `\u8FC1\u79FB\u4E2D\uFF1A${migrationProgress.copied}/${migrationProgress.total} \u4E2A\u6587\u4EF6\uFF08${migrationProgress.total > 0 ? Math.min(100, Math.round(migrationProgress.copied / migrationProgress.total * 100)) : 0}%\uFF09` : "\u51C6\u5907\u4E2D\u2026" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u8FC1\u79FB\u4E3A\u5F53\u524D\u65F6\u70B9\u5FEB\u7167\uFF1A\u4E0D\u505C\u6B62\u3001\u4E0D\u91CD\u542F\u4EFB\u4F55\u8FD0\u884C\u4E2D\u7684\u670D\u52A1\uFF1B\u6E90\u5728\u8FC1\u79FB\u671F\u95F4\u7684\u65B0\u6570\u636E\u4E0D\u5305\u542B\u5728\u526F\u672C\u5185\u3002\u76EE\u6807\u4E3A\u6FC0\u6D3B profile \u65F6\u62D2\u7EDD\u8FC1\u79FB\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "dsh \u8FD0\u884C\u65F6\uFF08\u7248\u672C\u4E0B\u8F7D / \u5207\u6362\uFF09", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        ThemeSelect,
        {
          style: { marginBottom: 8 },
          value: runtimeSource,
          onChange: (v) => setRuntimeSource(v),
          options: [
            { value: "github", label: "\u4E0B\u8F7D\u6E90\uFF1AGitHub Releases" },
            { value: "npm", label: "\u4E0B\u8F7D\u6E90\uFF1Anpm registry" }
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", onClick: () => void refreshRuntimes(), children: "\u5237\u65B0\u7248\u672C\u76EE\u5F55" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { marginTop: 8 }, children: [
        runtimeStatus.state === "error" && runtimeStatus.text && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: DANGER_NOTE_STYLE, children: runtimeStatus.text }),
        runtimeCatalog && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { marginBottom: 6 }, children: runtimeCatalog.mode === "external" ? `\u5F53\u524D\u4F7F\u7528\uFF1A\u5916\u90E8 dsh ${sourceState?.running?.version || sourceState?.external?.dsh_version || "\uFF08\u7248\u672C\u672A\u77E5\uFF09"}\uFF08\u8FD0\u884C\u65F6\u7248\u672C\u504F\u597D\u4EC5\u4FDD\u7559\uFF0C\u4E0D\u751F\u6548\uFF09` : runtimeCatalog.selected ? `\u5F53\u524D\u4F7F\u7528\uFF1A\u8FD0\u884C\u65F6 ${runtimeCatalog.selected}${runtimeCatalog.builtin ? "\uFF08\u5185\u7F6E\u515C\u5E95 " + runtimeCatalog.builtin + "\uFF09" : ""}` : runtimeCatalog.builtin ? `\u5F53\u524D\u4F7F\u7528\uFF1A\u5185\u7F6E dsh ${runtimeCatalog.builtin}\uFF08\u515C\u5E95\uFF09` : "\u5F53\u524D\u65E0\u53EF\u7528 dsh" }),
          (() => {
            const seen = /* @__PURE__ */ new Set();
            const heads = [];
            for (const ch of ["latest", "alpha", "rc"]) {
              const e = runtimeCatalog.catalog.find((c) => c.channel === ch);
              if (e && !seen.has(e.version)) {
                seen.add(e.version);
                heads.push(e);
              }
            }
            const installedPinned = runtimeCatalog.catalog.filter(
              (c) => !seen.has(c.version) && runtimeCatalog.installed.some((i) => i.version === c.version)
            );
            const rest = runtimeCatalog.catalog.filter((c) => !seen.has(c.version));
            const installedOnly = runtimeCatalog.installed.filter((i) => !runtimeCatalog.catalog.some((c) => c.version === i.version)).map((i) => ({ version: i.version, channel: "" }));
            if (runtimeCatalog.builtin && !runtimeCatalog.catalog.some((c) => c.version === runtimeCatalog.builtin) && !installedOnly.some((i) => i.version === runtimeCatalog.builtin)) {
              installedOnly.unshift({ version: runtimeCatalog.builtin, channel: "" });
            }
            const visible = runtimeExpanded ? [...runtimeCatalog.catalog, ...installedOnly] : [...heads, ...installedPinned, ...installedOnly.filter((i) => !seen.has(i.version))];
            return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
              visible.map((c) => {
                const installed = runtimeCatalog.installed.some((i) => i.version === c.version);
                const isBuiltin = runtimeCatalog.builtin === c.version;
                const available = installed || isBuiltin;
                const isCurrent = runtimeCatalog.mode === "external" ? false : runtimeCatalog.selected ? runtimeCatalog.selected === c.version : isBuiltin;
                const tags = [];
                if (c.channel) tags.push(c.channel);
                if (isBuiltin) tags.push("\u5185\u7F6E");
                else if (installed) tags.push("\u5DF2\u4E0B\u8F7D");
                const downloadState = runtimeDownloading[c.version];
                const failedReason = typeof downloadState === "object" ? downloadState.failed : "";
                const pct = dlProgress && dlProgress.version === c.version && dlProgress.resolved > 0 ? Math.min(100, Math.round(dlProgress.downloaded / dlProgress.resolved * 100)) : 0;
                return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { margin: "4px 0" }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                    "div",
                    {
                      style: {
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center"
                      },
                      children: [
                        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: `${c.version}${tags.length ? "\uFF08" + tags.join(" \xB7 ") + "\uFF09" : ""}` }),
                        !available ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                          PfBtn,
                          {
                            variant: "ghost",
                            disabled: downloadState === "downloading",
                            onClick: () => handleDownloadRuntime(c.version),
                            children: downloadState === "downloading" ? "\u4E0B\u8F7D\u4E2D\u2026" : failedReason ? "\u91CD\u8BD5\u4E0B\u8F7D" : downloadState === "downloaded" ? "\u5DF2\u4E0B\u8F7D" : "\u4E0B\u8F7D"
                          }
                        ) : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", gap: 6, alignItems: "center" }, children: [
                          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                            PfBtn,
                            {
                              variant: "ghost",
                              disabled: isCurrent,
                              onClick: () => handleSwitchRuntime(c.version),
                              children: isCurrent ? "\u4F7F\u7528\u4E2D" : "\u5207\u6362\u5230\u6B64\u7248\u672C"
                            }
                          ),
                          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                            PfBtn,
                            {
                              variant: "danger",
                              disabled: removingVersion !== null || runtimeCatalog.selected === c.version || c.version === runtimeCatalog.builtin,
                              title: runtimeCatalog.selected === c.version ? "\u4F7F\u7528\u4E2D\u7684\u7248\u672C\u4E0D\u53EF\u5378\u8F7D\uFF0C\u8BF7\u5148\u5207\u6362" : c.version === runtimeCatalog.builtin ? "\u5185\u7F6E\u7248\u672C\u968F\u5E94\u7528\u5206\u53D1\uFF0C\u4E0D\u53EF\u5378\u8F7D" : "\u5220\u9664\u672C\u5730\u5DF2\u4E0B\u8F7D\u7684\u8FD0\u884C\u65F6",
                              onClick: () => handleRemoveRuntime(c.version),
                              children: removingVersion === c.version ? "\u5378\u8F7D\u4E2D\u2026" : "\u5378\u8F7D"
                            }
                          )
                        ] })
                      ]
                    }
                  ),
                  downloadState === "downloading" && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { marginTop: 4 }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                      "div",
                      {
                        style: {
                          height: 6,
                          borderRadius: 4,
                          background: "var(--dsw-alias-bg-base,#111)",
                          overflow: "hidden"
                        },
                        children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                          "div",
                          {
                            style: {
                              height: "100%",
                              width: `${pct}%`,
                              background: "var(--dsw-alias-state-accent-primary,#3b82f6)",
                              transition: "width .3s"
                            }
                          }
                        )
                      }
                    ),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: dlProgress && dlProgress.version === c.version ? `\u5B89\u88C5\u4F9D\u8D56\uFF1A\u5DF2\u4E0B\u8F7D ${dlProgress.downloaded} / ${dlProgress.resolved || "\u2026"} \u4E2A\u5305${dlProgress.resolved > 0 ? `\uFF08${pct}%\uFF09` : ""}` : "\u51C6\u5907\u4E2D\u2026" })
                  ] }),
                  failedReason && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { ...DANGER_NOTE_STYLE, marginTop: 4, whiteSpace: "pre-wrap" }, children: [
                    "\u4E0B\u8F7D\u5931\u8D25\uFF1A",
                    failedReason
                  ] })
                ] }, c.version);
              }),
              rest.length > 0 && !runtimeExpanded && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(PfBtn, { variant: "ghost", style: { marginTop: 4 }, onClick: () => setRuntimeExpanded(true), children: [
                "\u5C55\u5F00\u5168\u90E8 ",
                runtimeCatalog.catalog.length,
                " \u4E2A\u7248\u672C \u25BE"
              ] }),
              runtimeExpanded && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", style: { marginTop: 4 }, onClick: () => setRuntimeExpanded(false), children: "\u6536\u8D77\u7248\u672C\u5217\u8868 \u25B4" })
            ] });
          })()
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "\u4F9D\u8D56\u72B6\u6001\uFF08pnpm store \u4E00\u81F4\u6027\uFF09", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "dsh \u7684\u63D2\u4EF6\u5B89\u88C5/\u5378\u8F7D\u7531\u5185\u7F6E pnpm \u6267\u884C\uFF1Bprofile \u7684 node_modules \u82E5\u7531\u5176\u5B83 pnpm \u7248\u672C\u88C5\u8FC7\uFF0C store \u5927\u7248\u672C\u4E0D\u4E00\u81F4\u4F1A\u62A5 ERR_PNPM_UNEXPECTED_STORE\u3002\u6B64\u5904\u53EF\u67E5\u770B\u5E76\u91CD\u5EFA\u3002" }),
      depProfiles === null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: NOTE_STYLE, children: [
        "\u8BFB\u53D6\u5931\u8D25\uFF1A",
        depError ?? "\u672A\u77E5\u539F\u56E0"
      ] }) : depProfiles.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u672A\u53D1\u73B0 profile" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("table", { style: { width: "100%", fontSize: 12, borderCollapse: "collapse" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { style: { textAlign: "left", opacity: 0.75 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "Profile" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "\u4F9D\u8D56\u7531 pnpm" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "\u5185\u7F6E pnpm" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" }, children: "\u72B6\u6001" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { style: { padding: "4px 6px" } })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tbody", { children: depProfiles.map((p) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px" }, children: p.profile }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px", opacity: 0.85 }, children: p.recordedPnpm ?? "\u672A\u77E5" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px", opacity: 0.85 }, children: p.builtinPnpm ?? "\u672A\u77E5" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px" }, children: !p.needsRebuild ? "\u4E00\u81F4" : p.running ? "\u9700\u91CD\u5EFA\uFF08\u8FD0\u884C\u4E2D\uFF09" : "\u9700\u91CD\u5EFA" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { style: { padding: "4px 6px" }, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            PfBtn,
            {
              variant: "ghost",
              disabled: !p.needsRebuild || p.running || depRebuilding !== null,
              title: p.running ? "\u8BE5 profile \u6B63\u5728\u8FD0\u884C\uFF1A\u5148\u505C\u6B62\u518D\u91CD\u5EFA" : p.needsRebuild ? "\u7528\u5185\u7F6E pnpm \u91CD\u5EFA\u4F9D\u8D56\uFF08\u8FC1\u79FB store \u5927\u7248\u672C\uFF09" : "\u65E0\u9700\u91CD\u5EFA",
              onClick: () => handleRebuildDeps(p.profile),
              children: depRebuilding === p.profile ? "\u91CD\u5EFA\u4E2D\u2026" : "\u91CD\u5EFA"
            }
          ) })
        ] }, p.profile)) })
      ] }),
      depNote ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: depNote }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "\u4E0B\u8F7D", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: ROW_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            placeholder: "1-32",
            "data-desktop-settings": "download-concurrency",
            style: { ...INPUT_BASE_STYLE, width: 80 },
            value: concurrencyInput,
            onChange: (e) => {
              concurrencyTouchedRef.current = true;
              setConcurrencyInput(e.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", onClick: handleSaveConcurrency, children: "\u4FDD\u5B58" })
      ] }),
      downloadBoxNote && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: downloadBoxNote }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u540C\u65F6\u8FDB\u884C\u7684\u4E0B\u8F7D\u6570\u4E0A\u9650\uFF0C\u8D85\u51FA\u6392\u961F\uFF1B\u6539\u52A8\u7ACB\u5373\u751F\u6548\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(SectionBox, { title: "\u4EE3\u7406\u8BBE\u7F6E", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "\u4EE3\u7406\u6A21\u5F0F" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        ThemeSelect,
        {
          style: { marginBottom: 10 },
          value: proxy.proxy_mode,
          onChange: (v) => setProxy({ ...proxy, proxy_mode: v }),
          options: [
            { value: "off", label: "\u4E0D\u4F7F\u7528\u4EE3\u7406" },
            { value: "system", label: "\u8DDF\u968F\u7CFB\u7EDF\u4EE3\u7406" },
            { value: "manual", label: "\u624B\u52A8\u6307\u5B9A\u4EE3\u7406" }
          ]
        }
      ),
      proxy.proxy_mode === "manual" && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "\u4EE3\u7406 URL" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            placeholder: "http/https/socks5://host:port",
            value: proxy.proxy_url,
            className: "pf-input",
            style: INPUT_FULL_STYLE,
            "data-desktop-settings": "proxy-url",
            onChange: (e) => setProxy({ ...proxy, proxy_url: e.target.value.trim() })
          }
        )
      ] }),
      (proxy.proxy_mode === "manual" || proxy.proxy_mode === "system") && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
        proxy.proxy_mode === "manual" && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "NO_PROXY\uFF08\u4E0D\u8D70\u4EE3\u7406\u7684\u5730\u5740\uFF0C\u9017\u53F7\u5206\u9694\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "input",
            {
              placeholder: "localhost,127.0.0.1,*.internal",
              value: proxy.no_proxy,
              className: "pf-input",
              style: INPUT_FULL_STYLE,
              "data-desktop-settings": "no-proxy",
              onChange: (e) => setProxy({ ...proxy, no_proxy: e.target.value.trim() })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: FLEX_1_STYLE, children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "\u7528\u6237\u540D\uFF08\u53EF\u9009\uFF09" }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "input",
              {
                value: proxy.proxy_user,
                className: "pf-input",
                style: INPUT_FULL_STYLE,
                "data-desktop-settings": "proxy-user",
                onChange: (e) => setProxy({ ...proxy, proxy_user: e.target.value })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: FLEX_1_STYLE, children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: LABEL_STYLE, children: "\u5BC6\u7801\uFF08\u53EF\u9009\uFF09" }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "input",
              {
                type: "password",
                value: proxy.proxy_pass,
                className: "pf-input",
                style: INPUT_FULL_STYLE,
                "data-desktop-settings": "proxy-pass",
                onChange: (e) => setProxy({ ...proxy, proxy_pass: e.target.value })
              }
            )
          ] })
        ] })
      ] }),
      proxyEffective && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: NOTE_STYLE, children: [
        "\u5F53\u524D\u751F\u6548\uFF1A",
        JSON.stringify(proxyEffective)
      ] }),
      proxy.proxy_mode === "system" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u7CFB\u7EDF\u4EE3\u7406\u6A21\u5F0F\u4E0B\uFF0C\u4EE3\u7406\u5730\u5740\u4E0E NO_PROXY \u6765\u81EA\u7CFB\u7EDF\u8BBE\u7F6E\uFF08\u5982 Windows \u6CE8\u518C\u8868 ProxyOverride\uFF09\uFF1B\u7528\u6237\u540D/\u5BC6\u7801\u4ECD\u53D6\u81EA\u8BBE\u7F6E\u5E76\u62FC\u5165\u4EE3\u7406\u5730\u5740\u3002" }),
      proxy.proxy_mode === "manual" && proxy.proxy_url && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { marginTop: 8 }, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "ghost", onClick: handleTestProxy, children: testBusy ? "\u6D4B\u8BD5\u4E2D\u2026" : "\u6D4B\u8BD5\u8FDE\u63A5" }) }),
        testResult && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: testResult })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PfBtn, { variant: "primary", disabled: busy, onClick: handleSaveProxy, children: busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u4EE3\u7406\u8BBE\u7F6E" }) }),
    msg && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      "div",
      {
        style: {
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 99999,
          padding: "10px 20px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 500,
          maxWidth: 480,
          boxShadow: "0 4px 12px rgba(0,0,0,.4)",
          cursor: "pointer",
          background: msg.ok ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
          border: `1px solid ${msg.ok ? "rgba(34,197,94,.6)" : "rgba(239,68,68,.6)"}`,
          color: msg.ok ? "#4ade80" : "#f87171",
          backdropFilter: "blur(8px)"
        },
        onClick: () => setMsg(null),
        children: msg.text
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: NOTE_STYLE, children: "\u670D\u52A1\u5730\u5740/Profile \u5207\u6362\u4F1A\u7ACB\u5373\u91CD\u542F dsh\uFF1B\u7AEF\u53E3\u4E0E\u4EE3\u7406\u5728\u4E0B\u6B21\u91CD\u542F\u540E\u751F\u6548\u3002" })
  ] });
}
function registerDesktopSettings(ctx) {
  if (!hasIpc3()) return;
  try {
    nsRpc = ctx.connection ?? null;
  } catch {
    nsRpc = null;
  }
  const slots = ctx.slots;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
  slots.inject(
    "settings.section",
    () => slots.register(
      { name: "settings.section", id: "dsh-desktop-settings", order: 40, label: () => "\u684C\u9762\u8BBE\u7F6E" },
      DesktopSettingsPanel
    )
  );
  void invoke4("get_pending_active_profile").then((profile) => {
    if (profile && nsRpc) {
      void nsSave({ active_profile: profile }).catch(() => {
      });
    }
  }).catch(() => {
  });
  void invoke4("check_startup_needed").then((res) => {
    if (!res || res.action === "none") return;
    if (res.action === "profile-selection") {
      const profiles = res.profiles ?? [];
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)";
      const card = document.createElement("div");
      card.style.cssText = "background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:24px;min-width:320px;max-width:400px";
      const title = document.createElement("div");
      title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:16px;color:var(--dsw-alias-label-primary,#e7eaf0)";
      title.textContent = "\u9009\u62E9\u8981\u542F\u52A8\u7684 Profile";
      card.appendChild(title);
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:8px";
      for (const p of profiles) {
        const btn = document.createElement("button");
        btn.style.cssText = "padding:10px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer;text-align:left";
        btn.textContent = p;
        btn.onmouseenter = () => btn.style.background = "var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))";
        btn.onmouseleave = () => btn.style.background = "transparent";
        btn.onclick = () => {
          el.remove();
          showToast(`\u6B63\u5728\u542F\u52A8 ${p} profile\u2026`, true);
          void invoke4("confirm_startup_profile", { name: p, repair: false }).catch((e) => showToast(`\u542F\u52A8\u5931\u8D25\uFF1A${String(e)}`, false));
        };
        list.appendChild(btn);
      }
      const input = document.createElement("input");
      input.style.cssText = "margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;width:100%;box-sizing:border-box";
      input.placeholder = "\u6216\u8F93\u5165\u65B0 profile \u540D\u79F0";
      const startBtn = document.createElement("button");
      startBtn.style.cssText = "margin-top:8px;padding:8px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer;width:100%";
      startBtn.textContent = "\u65B0\u5EFA\u5E76\u542F\u52A8";
      startBtn.onclick = () => {
        const name = input.value.trim();
        if (!name) return;
        el.remove();
        showToast(`\u6B63\u5728\u521B\u5EFA\u5E76\u542F\u52A8 ${name} profile\u2026`, true);
        void invoke4("confirm_startup_profile", { name, repair: true }).catch((e) => showToast(`\u521B\u5EFA\u5931\u8D25\uFF1A${String(e)}`, false));
      };
      card.appendChild(list);
      card.appendChild(input);
      card.appendChild(startBtn);
      el.appendChild(card);
      document.body.appendChild(el);
      return;
    }
    if (res.action === "profile-incomplete") {
      const profile = res.profile ?? "";
      if (!profile) return;
      const details = res.details;
      const missingDesc = details ? [
        ...details.missing_files,
        ...details.node_modules_exists ? [] : ["node_modules"],
        ...details.dir_exists ? [] : ["profile \u76EE\u5F55"]
      ].join(", ") : "";
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)";
      const card = document.createElement("div");
      card.style.cssText = "background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:24px;min-width:340px;max-width:420px;text-align:center";
      const title = document.createElement("div");
      title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary,#e7eaf0)";
      title.textContent = `Profile\u300C${profile}\u300D\u4E0D\u5B8C\u6574`;
      const desc = document.createElement("div");
      desc.style.cssText = "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:20px";
      desc.textContent = `\u7F3A\u5931\uFF1A${missingDesc}\u3002\u662F\u5426\u4FEE\u590D\uFF1F`;
      const btns = document.createElement("div");
      btns.style.cssText = "display:flex;gap:10px";
      const noBtn = document.createElement("button");
      noBtn.style.cssText = "flex:1;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer";
      noBtn.textContent = "\u76F4\u63A5\u542F\u52A8";
      noBtn.onclick = () => {
        el.remove();
        void invoke4("confirm_startup_profile", { name: profile, repair: false }).catch((e) => showToast(`\u542F\u52A8\u5931\u8D25\uFF1A${String(e)}`, false));
      };
      const yesBtn = document.createElement("button");
      yesBtn.style.cssText = "flex:1;padding:10px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer";
      yesBtn.textContent = "\u4FEE\u590D\u5E76\u542F\u52A8";
      yesBtn.onclick = () => {
        el.remove();
        showToast(`\u6B63\u5728\u4FEE\u590D ${profile} profile\u2026`, true);
        void invoke4("confirm_startup_profile", { name: profile, repair: true }).catch((e) => showToast(`\u4FEE\u590D\u5931\u8D25\uFF1A${String(e)}`, false));
      };
      btns.appendChild(noBtn);
      btns.appendChild(yesBtn);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(btns);
      el.appendChild(card);
      document.body.appendChild(el);
    }
  }).catch(() => {
  });
}

// src/client/environment.ts
var MODES = /* @__PURE__ */ new Set(["compatibility", "advanced"]);
var PLATFORMS = /* @__PURE__ */ new Set(["darwin", "win32", "linux"]);
function parseDesktopClientEnvironment(search) {
  const params = new URLSearchParams(search);
  const mode = params.get("dsh-desktop-tauriapp-mode");
  const platform = params.get("dsh-desktop-tauriapp-platform");
  if (mode === null && platform === null) return void 0;
  if (!MODES.has(mode)) {
    throw new Error(`dsh-desktop-tauriapp: invalid or missing dsh-desktop-tauriapp-mode ${JSON.stringify(mode)}`);
  }
  if (!PLATFORMS.has(platform)) {
    throw new Error(`dsh-desktop-tauriapp: invalid or missing dsh-desktop-tauriapp-platform ${JSON.stringify(platform)}`);
  }
  return { mode, platform };
}
async function requestDesktopClientEnvironment() {
  const w = window;
  let raw;
  try {
    if (w.__TAURI_INTERNALS__?.invoke) {
      raw = await w.__TAURI_INTERNALS__.invoke("get_desktop_client_environment", void 0);
    } else if (w.__TAURI__?.core?.invoke) {
      raw = await w.__TAURI__.core.invoke("get_desktop_client_environment", {});
    } else {
      return void 0;
    }
  } catch {
    return void 0;
  }
  const env = raw;
  if (!env) return void 0;
  if (env.mode !== "compatibility" && env.mode !== "advanced") return void 0;
  if (env.platform !== "darwin" && env.platform !== "win32" && env.platform !== "linux") return void 0;
  return { mode: env.mode, platform: env.platform, profile: typeof env.profile === "string" ? env.profile : void 0 };
}

// src/client/index.ts
var inject = [
  "slots",
  "sessions",
  "theme",
  "workspaces",
  "connection"
];
function installWebviewConsoleMirror() {
  const w = window;
  const invoke5 = (cmd, args) => {
    const a = w.__TAURI__?.core?.invoke;
    if (a) {
      a(cmd, args).catch(() => {
      });
      return;
    }
    const b = w.__TAURI_INTERNALS__?.invoke;
    if (b) {
      b(cmd, args, void 0).catch(() => {
      });
      return;
    }
  };
  const fwd = (level, args) => {
    try {
      const msg = args.map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      }).join(" ");
      const url = typeof location !== "undefined" && location.href || "?";
      invoke5("log_console", { level, msg, pageUrl: url });
    } catch {
    }
  };
  const levels = ["log", "info", "warn", "error", "debug"];
  for (const lvl of levels) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => {
      fwd(lvl, a);
      orig.apply(console, a);
    };
  }
  window.addEventListener("error", (e) => {
    const msg = e.error?.stack || e.message || "Uncaught error";
    fwd("error", [msg]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    fwd("error", [`Unhandled rejection: ${r?.message || String(e.reason)}`, r?.stack || ""]);
  });
}
function installNoRubberBand() {
  try {
    const style = document.createElement("style");
    style.dataset.dshDesktopNoBounce = "1";
    style.textContent = "html{overscroll-behavior:none;-webkit-overflow-scrolling:touch;} body{overscroll-behavior:none;}";
    (document.head || document.documentElement).appendChild(style);
  } catch {
  }
}
function apply(ctx) {
  installWebviewConsoleMirror();
  installNoRubberBand();
  registerDownloadsTab(ctx);
  installDownloadInterceptor();
  installDesktopBrowserBridge();
  registerDesktopSettings(ctx);
  void requestDesktopClientEnvironment().then((environment) => {
    if (environment?.mode === "advanced") applyAdvancedShell(ctx, environment);
  }).catch(() => {
  });
}
return module.exports;
  }
});

//# sourceMappingURL=client.js.map
