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
    const internals = window.__TAURI_INTERNALS__;
    if (internals?.invoke !== void 0) void internals.invoke(command).catch(() => void 0);
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
  const children = Array.from(frame.children).filter((el3) => el3 instanceof HTMLElement);
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
  function tauriInvoke2() {
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
    const invoke5 = tauriInvoke2();
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
  const isScrollableY = (el3) => {
    const oy = getComputedStyle(el3).overflowY;
    return oy === "auto" || oy === "scroll";
  };
  const ensureSidebarScroll = (sidebar) => {
    let root = null;
    const slot = document.querySelector('[data-slot="sidebar"]');
    if (slot !== null) {
      root = Array.from(slot.children).find((el3) => el3 instanceof HTMLElement) ?? null;
    }
    if (root === null) {
      root = Array.from(sidebar.children).find((el3) => el3 instanceof HTMLElement) ?? null;
    }
    if (root === null) return;
    root.style.flexWrap = "nowrap";
    root.style.width = "100%";
    root.style.maxWidth = "100%";
    root.style.minWidth = "0";
    root.style.overflowX = "auto";
    scrollRoot = root;
    const region = Array.from(root.children).find((el3) => {
      return el3 instanceof HTMLElement && getComputedStyle(el3).flexGrow === "1";
    });
    if (region === void 0) return;
    scrollRegion = region;
    minWidthPatched.length = 0;
    const visit = (el3) => {
      const style = getComputedStyle(el3);
      if (style.display.includes("flex")) {
        el3.style.minWidth = "0";
        minWidthPatched.push(el3);
      }
      if (isScrollableY(el3)) {
        el3.style.overflowX = "auto";
        overflowXPatched.push(el3);
      }
      for (const child of el3.children) {
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
    for (const el3 of minWidthPatched) el3.style.minWidth = "";
    for (const el3 of overflowXPatched) el3.style.overflowX = "";
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

// src/client/external-links.ts
var EXTERNAL_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:", "mailto:", "tel:"]);
function tauriInvoke() {
  const w = window;
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__.core.invoke;
  if (w.__TAURI_INTERNALS__?.invoke) {
    const inner = w.__TAURI_INTERNALS__.invoke;
    return (cmd, args) => inner(cmd, args ?? {}, void 0);
  }
  return void 0;
}
function diag(msg) {
  const invoke5 = tauriInvoke();
  if (!invoke5) return;
  invoke5("log_diag", { msg }).catch(() => {
  });
}
function externalUrl(href) {
  if (!href) return void 0;
  let url;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return void 0;
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.href;
    if (url.host !== window.location.host) return url.href;
  }
  return void 0;
}
function openInSystem(url) {
  const invoke5 = tauriInvoke();
  if (invoke5) {
    invoke5("open_external", { url }).then(() => {
      diag("\u5DF2\u8F6C\u4EA4\u7CFB\u7EDF\u6253\u5F00: " + url);
      if (typeof console !== "undefined" && typeof console.debug === "function") {
        console.debug("[dsh-desktop-tauriapp] \u5DF2\u8F6C\u4EA4\u7CFB\u7EDF\u6253\u5F00\uFF1A", url);
      }
    }).catch((e) => {
      diag("open_external \u8C03\u7528\u5931\u8D25: " + String(e) + " | " + url);
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[dsh-desktop-tauriapp] open_external \u8C03\u7528\u5931\u8D25\uFF1A", e, url);
      }
      try {
        window.open(url, "_blank", "noopener");
      } catch {
      }
    });
  } else {
    try {
      window.open(url, "_blank", "noopener");
    } catch {
    }
  }
}
function installExternalLinkHandler() {
  const onClick = (event) => {
    if (!tauriInvoke()) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0 && event.button !== 1) return;
    const el3 = event.target;
    const anchor = el3?.closest?.("a");
    if (!anchor) return;
    const url = externalUrl(anchor.getAttribute("href"));
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    diag("\u62E6\u622A\u5230\u5916\u94FE: " + url);
    openInSystem(url);
  };
  const onAuxClick = (event) => onClick(event);
  const originalOpen = window.open.bind(window);
  const openOverride = (url, target, features) => {
    const external = externalUrl(typeof url === "string" ? url : url?.href);
    if (external && tauriInvoke()) {
      diag("window.open \u5916\u94FE: " + external);
      openInSystem(external);
      return null;
    }
    return originalOpen(typeof url === "string" ? url : url, target, features);
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onAuxClick, true);
  window.open = openOverride;
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("auxclick", onAuxClick, true);
    if (window.open === openOverride) window.open = originalOpen;
  };
}

// src/client/downloads-tab.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
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
function DownloadsIcon({ size = 16, className }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", className, "aria-hidden": true, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8 2v7m0 0l-3-3m3 3l3-3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })
  ] });
}
function DownloadsTabTitle() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadsIcon, { size: 16 }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 4 }, children: "\u4E0B\u8F7D" })
  ] });
}
function DownloadsHeaderButton() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HeaderButtonInner, {});
}
function HeaderButtonInner() {
  const open = () => {
    if (headerOpenAction) headerOpenAction();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      onClick: open,
      title: "\u4E0B\u8F7D\u7BA1\u7406\u5668",
      style: { display: "inline-flex", alignItems: "center", padding: 4, border: "none", background: "transparent", color: "inherit", cursor: "pointer", borderRadius: 6 },
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadsIcon, { size: 16 })
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
            icon: DownloadsIcon
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
        () => slots.register({ name: "conversation.session.header.utilities", key: "dsh-desktop-tauriapp-downloads" }, DownloadsHeaderButton)
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

// src/client/desktop-settings.ts
var import_react2 = __toESM(require("react"), 1);
var NS_CHANNEL = "/dsh-desktop-fuse-settings";
var nsRpc = null;
function hasIpc3() {
  const w = window;
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}
function invoke3(cmd, args) {
  const w = window;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args);
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args);
  return Promise.reject(new Error("no tauri ipc"));
}
function el(tag, text, style) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (style) e.style.cssText = style;
  return e;
}
var stylesInstalled = false;
function ensureStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.dataset.desktopSettings = "styles";
  style.textContent = `
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
  document.head.appendChild(style);
}
function DesktopSettingsPanel() {
  const ref = import_react2.default.useRef(null);
  import_react2.default.useEffect(() => {
    const host = ref.current;
    if (!host || host.childNodes.length) return;
    ensureStyles();
    try {
      const root = buildPanel();
      host.appendChild(root);
      void loadAll(root);
    } catch (err) {
      host.appendChild(el("div", `\u684C\u9762\u8BBE\u7F6E\u9762\u677F\u521D\u59CB\u5316\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
    return () => {
      host.replaceChildren();
    };
  }, []);
  return import_react2.default.createElement("div", { ref });
}
async function loadAll(root) {
}
function buildPanel() {
  const root = el("div", void 0, "display:flex;flex-direction:column;gap:14px;max-width:680px;font-size:13px;");
  root.dataset.desktopSettings = "panel";
  let proxy = { proxy_mode: "off", proxy_url: "", no_proxy: "", proxy_user: "", proxy_pass: "" };
  let effective = void 0;
  let desktop = { remote_addr: null, remote_list: [], port: 3080, profiles: [] };
  let newRemoteUrl = "";
  let portDraft = "";
  let downloadConcurrency = 3;
  let testResult = null;
  let testBusy = false;
  let msg = null;
  let busy = false;
  function section(title) {
    const box = el("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:14px 16px;");
    box.appendChild(el("div", title, "pf-title"));
    return { box, body: box };
  }
  function note(box, text) {
    box.appendChild(el("div", text, "pf-note"));
  }
  function render() {
    root.replaceChildren();
    {
      const { box } = section("dsh \u670D\u52A1\u5730\u5740");
      const remoteSel = document.createElement("select");
      remoteSel.style.cssText = "width:100%;margin-bottom:8px;";
      const localOpt = document.createElement("option");
      localOpt.value = "";
      localOpt.textContent = "\u672C\u5730\uFF08127.0.0.1\uFF09";
      if (!desktop.remote_addr) localOpt.selected = true;
      remoteSel.appendChild(localOpt);
      for (const addr of desktop.remote_list) {
        const o = document.createElement("option");
        o.value = addr;
        o.textContent = addr;
        if (desktop.remote_addr === addr) o.selected = true;
        remoteSel.appendChild(o);
      }
      remoteSel.addEventListener("change", () => void doSelectRemote(remoteSel.value || null));
      box.appendChild(remoteSel);
      const addRow = el("div", void 0, "display:flex;gap:8px;");
      const addInput = document.createElement("input");
      addInput.placeholder = "\u65B0\u589E\uFF1Adsh web \u6253\u5370\u7684\u5B8C\u6574 URL\uFF08\u542B token\uFF09\u6216 host[:port]";
      addInput.className = "pf-input";
      addInput.style.flex = "1";
      addInput.dataset.desktopSettings = "remote-add";
      addInput.addEventListener("change", () => {
        newRemoteUrl = addInput.value.trim();
      });
      const addBtn = el("button", "\u65B0\u589E");
      addBtn.className = "pf-btn ghost";
      addBtn.addEventListener("click", () => void doAddRemote());
      addRow.append(addInput, addBtn);
      box.appendChild(addRow);
      if (desktop.remote_list.length) {
        const delRow = el("div", void 0, "display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;");
        for (const addr of desktop.remote_list) {
          const delBtn = el("button", `\u5220\u9664\uFF1A${addr}`);
          delBtn.className = "pf-btn danger";
          delBtn.style.fontSize = "11px";
          delBtn.addEventListener("click", () => void doRemoveRemote(addr));
          delRow.appendChild(delBtn);
        }
        box.appendChild(delRow);
      }
      note(box, "\u9009\u62E9\u8FDC\u7A0B\u5730\u5740\u540E\u7ACB\u5373\u6309\u5F53\u524D\u6A21\u5F0F\u91CD\u542F dsh\uFF1B\u65B0\u589E/\u5220\u9664\u4EC5\u6539\u5217\u8868\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002");
      root.appendChild(box);
    }
    {
      const { box } = section("Profile");
      const profSel = document.createElement("select");
      profSel.style.cssText = "width:100%;margin-bottom:8px;";
      for (const p of desktop.profiles) {
        const o = document.createElement("option");
        o.value = p.name;
        o.textContent = p.active ? `\u2713 ${p.name}` : p.name;
        if (p.active) o.selected = true;
        profSel.appendChild(o);
      }
      profSel.addEventListener("change", () => void doSwitchProfile(profSel.value));
      box.appendChild(profSel);
      note(box, "\u5207\u6362 Profile \u4F1A\u4EE5\u76EE\u6807 profile \u91CD\u542F dsh web\u3002");
      root.appendChild(box);
    }
    {
      const { box } = section("\u672C\u5730\u7AEF\u53E3");
      const row = el("div", void 0, "display:flex;gap:8px;align-items:center;");
      const portInput = document.createElement("input");
      portInput.placeholder = `\u5F53\u524D ${desktop.port}`;
      portInput.value = portDraft;
      portInput.style.width = "140px";
      portInput.dataset.desktopSettings = "port";
      portInput.addEventListener("change", () => {
        portDraft = portInput.value.trim();
      });
      const portBtn = el("button", "\u4FDD\u5B58\u7AEF\u53E3");
      portBtn.className = "pf-btn ghost";
      portBtn.addEventListener("click", () => void doSavePort());
      row.append(portInput, portBtn);
      box.appendChild(row);
      note(box, "\u6539\u52A8\u540E\u9700\u91CD\u542F dsh \u751F\u6548\uFF08\u53EF\u7528\u6258\u76D8\u300C\u91CD\u542F dsh \u670D\u52A1\u300D\uFF09\u3002");
      root.appendChild(box);
    }
    {
      const { box } = section("\u4E0B\u8F7D");
      const row = el("div", void 0, "display:flex;gap:8px;align-items:center;");
      const concInput = document.createElement("input");
      concInput.placeholder = "1-32";
      invoke3("get_download_settings").then((s) => {
        downloadConcurrency = s.concurrency;
        if (concInput.dataset.userTouched !== "1") concInput.value = String(s.concurrency);
      }).catch(() => {
      });
      concInput.dataset.desktopSettings = "load-concurrency";
      concInput.value = String(downloadConcurrency);
      concInput.style.width = "80px";
      concInput.dataset.desktopSettings = "download-concurrency";
      const concBtn = el("button", "\u4FDD\u5B58");
      concBtn.className = "pf-btn ghost";
      concBtn.addEventListener("click", () => {
        const v = Math.max(1, Math.min(32, parseInt(concInput.value, 10) || 3));
        invoke3("set_download_concurrency", { value: v }).then(() => {
          downloadConcurrency = v;
          note(box, `\u5DF2\u4FDD\u5B58\uFF1A\u5E76\u53D1\u4E0A\u9650 ${v}`);
        }).catch(() => note(box, "\u4FDD\u5B58\u5931\u8D25\uFF08\u65E0 Tauri IPC\uFF1F\uFF09"));
      });
      row.append(concInput, concBtn);
      box.appendChild(row);
      note(box, "\u540C\u65F6\u8FDB\u884C\u7684\u4E0B\u8F7D\u6570\u4E0A\u9650\uFF0C\u8D85\u51FA\u6392\u961F\uFF1B\u6539\u52A8\u7ACB\u5373\u751F\u6548\u3002");
      root.appendChild(box);
    }
    {
      const { box } = section("\u4EE3\u7406\u8BBE\u7F6E");
      box.appendChild(el("div", "\u4EE3\u7406\u6A21\u5F0F", "pf-label"));
      const modeSel = document.createElement("select");
      modeSel.style.cssText = "width:100%;margin-bottom:10px;";
      [["off", "\u4E0D\u4F7F\u7528\u4EE3\u7406"], ["system", "\u8DDF\u968F\u7CFB\u7EDF\u4EE3\u7406"], ["manual", "\u624B\u52A8\u6307\u5B9A\u4EE3\u7406"]].forEach(([v, l]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        if (v === proxy.proxy_mode) o.selected = true;
        modeSel.appendChild(o);
      });
      modeSel.addEventListener("change", () => {
        proxy.proxy_mode = modeSel.value;
        render();
      });
      box.appendChild(modeSel);
      if (proxy.proxy_mode === "manual") {
        box.appendChild(el("div", "\u4EE3\u7406 URL", "pf-label"));
        const urlInput = document.createElement("input");
        urlInput.placeholder = "http/https/socks5://host:port";
        urlInput.value = proxy.proxy_url;
        urlInput.className = "pf-input";
        urlInput.dataset.desktopSettings = "proxy-url";
        urlInput.addEventListener("change", () => {
          proxy.proxy_url = urlInput.value.trim();
        });
        box.appendChild(urlInput);
      }
      if (proxy.proxy_mode === "manual" || proxy.proxy_mode === "system") {
        box.appendChild(el("div", "NO_PROXY\uFF08\u4E0D\u8D70\u4EE3\u7406\u7684\u5730\u5740\uFF0C\u9017\u53F7\u5206\u9694\uFF09", "pf-label"));
        const npInput = document.createElement("input");
        npInput.placeholder = "localhost,127.0.0.1,*.internal";
        npInput.value = proxy.no_proxy;
        npInput.className = "pf-input";
        npInput.dataset.desktopSettings = "no-proxy";
        npInput.addEventListener("change", () => {
          proxy.no_proxy = npInput.value.trim();
        });
        box.appendChild(npInput);
        const authRow = el("div", void 0, "display:flex;gap:8px;margin-top:8px;");
        const userWrap = el("div", void 0, "flex:1;");
        userWrap.appendChild(el("div", "\u7528\u6237\u540D\uFF08\u53EF\u9009\uFF09", "pf-label"));
        const userInput = document.createElement("input");
        userInput.value = proxy.proxy_user;
        userInput.className = "pf-input";
        userInput.dataset.desktopSettings = "proxy-user";
        userInput.addEventListener("change", () => {
          proxy.proxy_user = userInput.value;
        });
        userWrap.appendChild(userInput);
        const passWrap = el("div", void 0, "flex:1;");
        passWrap.appendChild(el("div", "\u5BC6\u7801\uFF08\u53EF\u9009\uFF09", "pf-label"));
        const passInput = document.createElement("input");
        passInput.type = "password";
        passInput.value = proxy.proxy_pass;
        passInput.className = "pf-input";
        passInput.dataset.desktopSettings = "proxy-pass";
        passInput.addEventListener("change", () => {
          proxy.proxy_pass = passInput.value;
        });
        passWrap.appendChild(passInput);
        authRow.append(userWrap, passWrap);
        box.appendChild(authRow);
      }
      if (effective) {
        box.appendChild(el("div", `\u5F53\u524D\u751F\u6548\uFF1A${JSON.stringify(effective)}`, "pf-note"));
      }
      if (proxy.proxy_mode === "manual" && proxy.proxy_url) {
        const testBtn = el("button", testBusy ? "\u6D4B\u8BD5\u4E2D\u2026" : "\u6D4B\u8BD5\u8FDE\u63A5");
        testBtn.className = "pf-btn ghost";
        testBtn.style.marginTop = "8px";
        testBtn.addEventListener("click", () => void doTest());
        box.appendChild(testBtn);
        if (testResult) box.appendChild(el("div", testResult, "pf-note"));
      }
      root.appendChild(box);
    }
    const saveBtn = el("button", busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u4EE3\u7406\u8BBE\u7F6E");
    saveBtn.className = "pf-btn";
    saveBtn.style.marginTop = "4px";
    saveBtn.addEventListener("click", () => void doSave());
    root.appendChild(saveBtn);
    if (msg) {
      root.appendChild(el("div", msg.text, `font-size:12px;color:${msg.ok ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-state-danger-primary,#e5534b)"};`));
    }
    root.appendChild(el("div", "\u670D\u52A1\u5730\u5740/Profile \u5207\u6362\u4F1A\u7ACB\u5373\u91CD\u542F dsh\uFF1B\u7AEF\u53E3\u4E0E\u4EE3\u7406\u5728\u4E0B\u6B21\u91CD\u542F\u540E\u751F\u6548\u3002", "pf-note"));
  }
  function setMsg(ok, text) {
    msg = { ok, text };
  }
  async function nsSave(patch) {
    if (!nsRpc) throw new Error("dsh settings \u901A\u9053\u4E0D\u53EF\u7528\uFF08\u9700\u684C\u9762\u58F3\u73AF\u5883\uFF09");
    const r = await nsRpc.rpc.call(NS_CHANNEL, "save", { patch });
    if (!r?.ok) throw new Error(r?.error?.message ?? "\u4FDD\u5B58\u88AB\u62D2\u7EDD");
  }
  async function nsGet() {
    if (!nsRpc) throw new Error("dsh settings \u901A\u9053\u4E0D\u53EF\u7528\uFF08\u9700\u684C\u9762\u58F3\u73AF\u5883\uFF09");
    const r = await nsRpc.rpc.call(NS_CHANNEL, "get", {});
    if (!r?.ok) throw new Error(r?.error?.message ?? "\u8BFB\u53D6\u88AB\u62D2\u7EDD");
    return r.value && typeof r.value === "object" ? r.value : {};
  }
  async function doLoad() {
    try {
      const [ns, p, d] = await Promise.all([
        nsGet(),
        invoke3("get_proxy_settings"),
        invoke3("get_desktop_settings_data")
      ]);
      proxy = {
        proxy_mode: ns.proxy_mode || p.proxy_mode || "off",
        proxy_url: ns.proxy_url || p.proxy_url || "",
        no_proxy: ns.no_proxy || p.no_proxy || "",
        proxy_user: ns.proxy_user || p.proxy_user || "",
        proxy_pass: ns.proxy_pass || p.proxy_pass || ""
      };
      effective = p.effective;
      desktop = {
        remote_addr: ns.remote_addr ?? null,
        remote_list: ns.remote_list ?? d.remote_list ?? [],
        port: ns.port || d.port || 3080,
        profiles: d.profiles
      };
      portDraft = "";
    } catch (err) {
      setMsg(false, `\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25\uFF1A${String(err)}`);
    }
    render();
  }
  async function doSave() {
    if (busy) return;
    busy = true;
    render();
    try {
      await nsSave({
        proxy_mode: proxy.proxy_mode,
        proxy_url: proxy.proxy_url,
        no_proxy: proxy.no_proxy,
        proxy_user: proxy.proxy_user,
        proxy_pass: proxy.proxy_pass
      });
      setMsg(true, "\u4EE3\u7406\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF1B\u4E0B\u6B21 dsh \u91CD\u542F\u540E\u751F\u6548\u3002");
    } catch (err) {
      setMsg(false, `\u4FDD\u5B58\u5931\u8D25\uFF1A${String(err)}`);
    }
    busy = false;
    render();
  }
  async function doTest() {
    if (testBusy) return;
    testBusy = true;
    testResult = null;
    render();
    try {
      const ms = await invoke3("test_proxy_connectivity", { url: proxy.proxy_url });
      testResult = `\u8FDE\u63A5\u6210\u529F\uFF08${ms}ms\uFF09`;
    } catch (err) {
      testResult = `\u8FDE\u63A5\u5931\u8D25\uFF1A${String(err)}`;
    }
    testBusy = false;
    render();
  }
  async function doSelectRemote(addr) {
    try {
      await nsSave({ remote_addr: addr });
      await invoke3("restart_dsh_service");
      setMsg(true, "\u5DF2\u5207\u6362 dsh \u670D\u52A1\u6765\u6E90\uFF0C\u6B63\u5728\u91CD\u542F\u2026");
    } catch (err) {
      setMsg(false, `\u5207\u6362\u5931\u8D25\uFF1A${String(err)}`);
    }
    render();
  }
  function normalizeRemote(input) {
    const t = input.trim();
    if (!t) return null;
    if (/^https?:\/\//.test(t)) return t;
    if (/^socks5:\/\//.test(t)) return t;
    if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(t)) return `https://${t}`;
    return null;
  }
  async function doAddRemote() {
    const addr = normalizeRemote(newRemoteUrl);
    if (!addr) {
      setMsg(false, "\u5730\u5740\u975E\u6CD5\uFF1A\u9700 dsh web \u5B8C\u6574 URL\uFF08\u542B token\uFF09\u6216 host[:port]");
      render();
      return;
    }
    try {
      const list = Array.isArray(desktop.remote_list) ? [...desktop.remote_list] : [];
      if (!list.includes(addr)) list.push(addr);
      await nsSave({ remote_list: list });
      newRemoteUrl = "";
      setMsg(true, `\u5DF2\u65B0\u589E\u5730\u5740\uFF1A${addr}\uFF08\u672A\u5207\u6362\uFF0C\u8BF7\u5728\u4E0B\u62C9\u6846\u9009\u62E9\uFF09`);
    } catch (err) {
      setMsg(false, `\u65B0\u589E\u5931\u8D25\uFF1A${String(err)}`);
    }
    await refreshData();
  }
  async function doRemoveRemote(addr) {
    try {
      const list = (desktop.remote_list ?? []).filter((a) => a !== addr);
      const patch = { remote_list: list };
      if (desktop.remote_addr === addr) patch.remote_addr = null;
      await nsSave(patch);
      setMsg(true, `\u5DF2\u5220\u9664\uFF1A${addr}`);
    } catch (err) {
      setMsg(false, `\u5220\u9664\u5931\u8D25\uFF1A${String(err)}`);
    }
    await refreshData();
  }
  async function doSwitchProfile(name) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      setMsg(false, "Profile \u540D\u4E0D\u5408\u6CD5");
      render();
      return;
    }
    try {
      await nsSave({ active_profile: name });
      await invoke3("restart_dsh_service");
      setMsg(true, `\u5DF2\u5207\u6362\u5230 Profile\u300C${name}\u300D\uFF0C\u6B63\u5728\u91CD\u542F\u2026`);
    } catch (err) {
      setMsg(false, `\u5207\u6362 Profile \u5931\u8D25\uFF1A${String(err)}`);
    }
    render();
  }
  async function doSavePort() {
    const port = Number(portDraft);
    if (!portDraft || Number.isNaN(port) || port < 1 || port > 65535) {
      setMsg(false, "\u8BF7\u8F93\u5165 1-65535 \u7684\u6709\u6548\u7AEF\u53E3");
      render();
      return;
    }
    try {
      await nsSave({ port });
      portDraft = "";
      setMsg(true, `\u7AEF\u53E3\u5DF2\u6539\u4E3A ${port}\uFF1B\u91CD\u542F dsh \u540E\u751F\u6548\u3002`);
    } catch (err) {
      setMsg(false, `\u8BBE\u7F6E\u7AEF\u53E3\u5931\u8D25\uFF1A${String(err)}`);
    }
    await refreshData();
  }
  async function refreshData() {
    try {
      desktop = await invoke3("get_desktop_settings_data");
    } catch {
    }
    render();
  }
  void doLoad();
  render();
  return root;
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
}

// src/client/plugin-fuse.ts
var import_react3 = __toESM(require("react"), 1);
function hasIpc4() {
  const w = window;
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}
function invoke4(cmd, args) {
  const w = window;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args);
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args);
  return Promise.reject(new Error("no tauri ipc"));
}
var TYPE_LABEL = {
  "load-list": "\u52A0\u8F7D\u5931\u8D25",
  activation: "\u6FC0\u6D3B\u5931\u8D25",
  "loader-entry": "loader entry",
  "stack-id": "\u5916\u5C42\u6808",
  "duplicate-id": "\u91CD\u590D\u6302\u8F7D",
  "patch-parse": "patch \u89E3\u6790\u5931\u8D25"
};
function el2(tag, text, style) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (style) e.style.cssText = style;
  return e;
}
function frag(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content;
}
var fuseConnection = null;
function registerFusePanel(ctx) {
  if (!hasIpc4()) {
    ctx?.logger?.warn?.("plugin-fuse: \u65E0 Tauri IPC\uFF08\u7EAF\u6D4F\u89C8\u5668\uFF09\uFF0C\u8DF3\u8FC7\u8BBE\u7F6E\u5165\u53E3");
    return;
  }
  fuseConnection = ctx.connection ?? null;
  const slots = ctx.slots;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
    ctx?.logger?.warn?.("plugin-fuse: slots \u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u8BBE\u7F6E\u5165\u53E3");
    return;
  }
  slots.inject(
    "settings.section",
    () => slots.register(
      {
        name: "settings.section",
        id: "dsh-plugin-fuse",
        order: 30,
        label: () => "\u63D2\u4EF6\u4FDD\u9669\u4E1D"
      },
      FusePanel
    )
  );
}
function FusePanel() {
  const ref = import_react3.default.useRef(null);
  import_react3.default.useEffect(() => {
    const host = ref.current;
    if (!host || host.childNodes.length) return;
    let panel;
    try {
      panel = buildPanel2();
    } catch (err) {
      panel = el2("div", `\u63D2\u4EF6\u4FDD\u9669\u4E1D\u9762\u677F\u521D\u59CB\u5316\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;");
    }
    host.appendChild(panel);
    return () => {
      try {
        panel.remove();
      } catch {
      }
    };
  }, []);
  return import_react3.default.createElement("div", { ref });
}
var panelStylesInstalled = false;
function ensurePanelStyles() {
  if (panelStylesInstalled) return;
  panelStylesInstalled = true;
  const style = document.createElement("style");
  style.dataset.pluginFuseStyles = "1";
  style.textContent = `
[data-plugin-fuse] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s, background .12s; }
[data-plugin-fuse] .pf-btn:hover { filter:brightness(1.12); }
[data-plugin-fuse] .pf-btn:active { transform:translateY(1px); filter:brightness(.95); }
[data-plugin-fuse] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-plugin-fuse] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-plugin-fuse] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-plugin-fuse] .pf-btn.danger { background:transparent; border:1px solid var(--dsw-alias-state-danger-primary,#e5534b); color:var(--dsw-alias-state-danger-primary,#e5534b); }
[data-plugin-fuse] .pf-btn.danger:hover { background:rgba(229,83,75,.12); filter:none; }
[data-plugin-fuse] .pf-btn.danger:active { transform:translateY(1px); background:rgba(229,83,75,.2); filter:none; }
[data-plugin-fuse] .pf-btn.sm { padding:2px 8px; font-size:11px; border-radius:6px; }
[data-plugin-fuse] .pf-row { transition:background .12s; }
[data-plugin-fuse] .pf-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06)); }
[data-plugin-fuse] .pf-chip { transition:background .12s; border-radius:6px; }
[data-plugin-fuse] .pf-chip:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); }
`;
  document.head.appendChild(style);
}
function buildPanel2() {
  const state = {
    selected: 0,
    entries: [],
    profile: "web",
    doctor: null,
    explain: {},
    settings: null,
    showSettings: false,
    showRaw: true,
    doctorError: null,
    repairBusy: null,
    providerDir: null,
    repairMsg: null
  };
  const root = el2("div", void 0, "display:flex;flex-direction:column;gap:12px;max-width:900px;font-size:13px;");
  root.dataset.pluginFuse = "1";
  ensurePanelStyles();
  async function reload() {
    try {
      const resp = await invoke4("list_quarantine");
      state.profile = resp.profile;
      state.entries = resp.entries;
    } catch (err) {
      console.error("[plugin-fuse] list_quarantine \u5931\u8D25\uFF1A", err);
      state.entries = [];
      root.appendChild(el2("div", `\u8BFB\u53D6\u9694\u79BB\u540D\u5355\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
  }
  async function loadSummary() {
    try {
      const s = await invoke4("get_fuse_summary");
      if (Array.isArray(s?.disabled) && s.disabled.length) {
        state.summaryText = `\u672C\u6B21\u542F\u52A8\u81EA\u52A8\u7981\u7528\u4E86 ${s.disabled.length} \u4E2A\u63D2\u4EF6\uFF0C\u91CD\u8BD5 ${s.retried} \u6B21\u540E\u6210\u529F`;
      }
    } catch {
    }
  }
  ;
  state.summaryText = "";
  function render() {
    root.replaceChildren();
    const summaryText = state.summaryText;
    if (summaryText) {
      root.appendChild(frag(`<div style="display:flex;gap:10px;align-items:center;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-left:3px solid var(--dsw-alias-state-warning-primary,#e8a33d);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border-radius:8px;padding:10px 12px;font-size:12.5px"><span style="flex:1">${summaryText}</span></div>`));
    }
    const wrap = el2("div", void 0, "display:grid;grid-template-columns:264px 1fr;gap:16px;align-items:start;");
    const left = el2("div", void 0, "display:flex;flex-direction:column;gap:12px;");
    const list = el2("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;overflow:hidden;");
    if (!state.entries.length) {
      list.appendChild(el2("div", "\u5F53\u524D\u6CA1\u6709\u88AB\u9694\u79BB\u7684\u63D2\u4EF6\u3002", "padding:14px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12.5px;"));
    }
    state.entries.forEach((e2, i) => {
      const row = el2("div", void 0, `padding:11px 13px;border-bottom:1px solid var(--dsw-alias-border-l,#ffffff1f);cursor:pointer;${i === state.selected ? "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary-new-color,#4176e6);" : ""}`);
      row.className = "pf-row";
      const top = el2("div", void 0, "display:flex;justify-content:space-between;gap:8px;align-items:center;");
      top.appendChild(el2("b", e2.id, "font-size:12.5px;"));
      top.appendChild(el2("span", TYPE_LABEL[e2.failure_type] || e2.failure_type, "font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap;"));
      row.appendChild(top);
      row.appendChild(el2("div", e2.reason, "margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"));
      row.addEventListener("click", () => {
        state.selected = i;
        render();
      });
      list.appendChild(row);
    });
    left.appendChild(list);
    const doctorCard = el2("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:12px 14px;");
    doctorCard.appendChild(el2("b", "\u4F53\u68C0\uFF08doctor\uFF09", "font-size:12.5px;"));
    const doctorBody = el2("div", void 0, "margin-top:8px;display:flex;flex-direction:column;gap:6px;");
    if (state.doctor === "idle" || state.doctor === null) {
      doctorBody.appendChild(el2("div", "\u5C1A\u672A\u4F53\u68C0\uFF1A\u68C0\u67E5 dsh \u7248\u672C\u3001DSH_HOME\u3001profiles\u3001\u53F0\u8D26\u4E00\u81F4\u6027\u3001\u6258\u7BA1\u533A\u5757\u5065\u5EB7\u3002", "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      if (state.doctorError) {
        doctorBody.appendChild(el2("div", `\u4E0A\u6B21\u4F53\u68C0\u5931\u8D25\uFF1A${state.doctorError}`, "font-size:12px;color:var(--dsw-alias-state-danger-primary,#e5534b);word-break:break-all;"));
      }
    } else if (state.doctor === "running") {
      doctorBody.appendChild(el2("div", "\u4F53\u68C0\u4E2D\u2026", "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    } else {
      for (const c of state.doctor) {
        const row = el2("div", void 0, "display:flex;gap:8px;align-items:flex-start;font-size:12px;");
        const dot = el2("span", void 0, `width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;background:${c.ok ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-state-danger-primary,#e5534b)"};`);
        const text = el2("div");
        text.appendChild(el2("b", c.label, "font-size:12px;"));
        text.appendChild(el2("div", c.detail, "font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
        row.append(dot, text);
        doctorBody.appendChild(row);
      }
    }
    const doctorBtn = el2("button", state.doctor === "running" ? "\u4F53\u68C0\u4E2D\u2026" : "\u8FD0\u884C\u4F53\u68C0");
    doctorBtn.className = "pf-btn ghost";
    doctorBtn.style.marginTop = "8px";
    doctorBtn.addEventListener("click", () => void runDoctor());
    doctorCard.appendChild(doctorBody);
    doctorCard.appendChild(doctorBtn);
    left.appendChild(doctorCard);
    const setCard = el2("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;overflow:hidden;");
    const setHead = el2("div", void 0, "padding:11px 13px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:600;font-size:12.5px;");
    setHead.appendChild(el2("span", "\u8BBE\u7F6E"));
    setHead.appendChild(el2("span", state.showSettings ? "\u25BE" : "\u25B8", "color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    setHead.addEventListener("click", () => {
      state.showSettings = !state.showSettings;
      render();
    });
    setCard.appendChild(setHead);
    if (state.showSettings && state.settings) {
      const body = el2("div", void 0, "padding:0 13px 12px;display:flex;flex-direction:column;gap:10px;font-size:12px;");
      const fpRow = el2("div", void 0, "display:flex;justify-content:space-between;gap:10px;align-items:center;");
      fpRow.appendChild(el2("span", "\u7B2C\u4E00\u65B9\u63D2\u4EF6\u4FDD\u62A4\uFF08@deepseek-ai/* \u4E0D\u81EA\u52A8\u7981\u7528\uFF09"));
      const sw = el2("span", void 0, `position:relative;width:34px;height:19px;border-radius:999px;cursor:pointer;flex:none;background:${state.settings.first_party_protection ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-border-l,#ffffff1f)"};`);
      sw.style.cssText += `position:relative;`;
      const knob = el2("span", void 0, `position:absolute;top:2px;left:${state.settings.first_party_protection ? "17px" : "2px"};width:15px;height:15px;border-radius:50%;background:#fff;`);
      sw.appendChild(knob);
      sw.addEventListener("click", () => {
        state.settings.first_party_protection = !state.settings.first_party_protection;
        void saveSettings();
      });
      fpRow.appendChild(sw);
      body.appendChild(fpRow);
      const rtRow = el2("div", void 0, "display:flex;justify-content:space-between;gap:10px;align-items:center;");
      rtRow.appendChild(el2("span", "\u542F\u52A8\u5931\u8D25\u6700\u5927\u91CD\u8BD5\u6B21\u6570"));
      const rt = el2("span", void 0, "display:flex;gap:6px;align-items:center;");
      const minus = el2("button", "\u2212");
      const plus = el2("button", "\uFF0B");
      minus.className = "pf-btn ghost sm";
      plus.className = "pf-btn ghost sm";
      minus.addEventListener("click", () => {
        state.settings.max_retries = Math.max(0, state.settings.max_retries - 1);
        void saveSettings();
      });
      plus.addEventListener("click", () => {
        state.settings.max_retries = Math.min(5, state.settings.max_retries + 1);
        void saveSettings();
      });
      rt.append(minus, el2("b", String(state.settings.max_retries)), plus);
      rtRow.appendChild(rt);
      body.appendChild(rtRow);
      const exclWrap = el2("div");
      exclWrap.appendChild(el2("div", "\u6392\u9664\u540D\u5355\uFF08\u6C38\u4E0D\u81EA\u52A8\u7981\u7528\uFF0C\u70B9\u51FB \u2715 \u79FB\u9664\uFF09", "margin-bottom:6px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      const chips = el2("div", void 0, "display:flex;flex-wrap:wrap;gap:6px;");
      for (const x of state.settings.exclude) {
        const chip = el2("span", `${x} \u2715`, "font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2);");
        chip.className = "pf-chip";
        chip.addEventListener("click", () => {
          state.settings.exclude = state.settings.exclude.filter((y) => y !== x);
          void saveSettings();
        });
        chips.appendChild(chip);
      }
      const addChip = el2("span", "\uFF0B \u6DFB\u52A0", "font-size:11px;border:1px dashed var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2);");
      addChip.className = "pf-chip";
      addChip.addEventListener("click", () => {
        const v = window.prompt("\u6392\u9664\u7684\u63D2\u4EF6 id \u6216\u5305\u540D\uFF1A");
        if (v && v.trim()) {
          state.settings.exclude.push(v.trim());
          void saveSettings();
        }
      });
      chips.appendChild(addChip);
      exclWrap.appendChild(chips);
      body.appendChild(exclWrap);
      const aiHd = el2("div", "AI \u89E3\u8BFB\uFF08explain\uFF09", "font-weight:600;font-size:12px;");
      body.appendChild(aiHd);
      const provSel = document.createElement("select");
      provSel.style.cssText = "width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:inherit;font-size:12px;";
      if (typeof state.providerDir === "string") {
        provSel.appendChild(el2("option", "\u52A0\u8F7D\u4E2D\u2026"));
        provSel.disabled = true;
      } else if (!Array.isArray(state.providerDir)) {
        provSel.appendChild(el2("option", `\u52A0\u8F7D\u5931\u8D25\uFF1A${state.providerDir.error}`));
        provSel.disabled = true;
      } else if (!state.providerDir.length) {
        provSel.appendChild(el2("option", "dsh \u672A\u6CE8\u518C\u4EFB\u4F55 provider"));
        provSel.disabled = true;
      } else {
        for (const p of state.providerDir) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = `${p.name}\uFF08${p.models.length} \u4E2A\u6A21\u578B\uFF09`;
          if (p.id === state.settings.ai_provider) opt.selected = true;
          provSel.appendChild(opt);
        }
      }
      provSel.addEventListener("change", () => {
        state.settings.ai_provider = provSel.value;
        const p = Array.isArray(state.providerDir) ? state.providerDir.find((x) => x.id === provSel.value) : void 0;
        if (p?.models.length) state.settings.ai_model = p.models[0].id;
        void saveSettings();
        render();
      });
      body.appendChild(provSel);
      body.appendChild(el2("div", "\u6A21\u578B", "font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-top:6px;"));
      const modelSel = document.createElement("select");
      modelSel.style.cssText = "width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:inherit;font-size:12px;margin-top:6px;";
      const selProvider = Array.isArray(state.providerDir) ? state.providerDir.find((p) => p.id === state.settings.ai_provider) : void 0;
      const models = selProvider?.models ?? [];
      if (!models.length) {
        modelSel.appendChild(el2("option", selProvider ? "\u8BE5 provider \u65E0\u5DF2\u5B89\u88C5\u6A21\u578B" : "\u672A\u9009\u4E2D provider"));
        modelSel.disabled = true;
      } else {
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.name || m.id;
          if (m.id === state.settings.ai_model) opt.selected = true;
          modelSel.appendChild(opt);
        }
      }
      modelSel.addEventListener("change", () => {
        state.settings.ai_model = modelSel.value;
        void saveSettings();
      });
      body.appendChild(modelSel);
      body.appendChild(el2("div", "Provider \u4E0E\u6A21\u578B\u5217\u8868\u4ECE dsh llm \u76EE\u5F55\u670D\u52A1\u52A8\u6001\u83B7\u53D6\uFF08\u4E0E dsh-mnemon \u540C\u4E00\u6570\u636E\u6E90\uFF09\u3002", "font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      setCard.appendChild(body);
    }
    left.appendChild(setCard);
    wrap.appendChild(left);
    const right = el2("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;align-self:start;min-height:220px;");
    const e = state.entries[Math.min(state.selected, Math.max(state.entries.length - 1, 0))];
    if (!e) {
      right.appendChild(el2("div", "\u9009\u62E9\u5DE6\u4FA7\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5\u3002", "color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12.5px;"));
    } else {
      const head = el2("div", void 0, "display:flex;justify-content:space-between;align-items:center;gap:8px;");
      head.appendChild(el2("b", e.id, "font-size:14px;"));
      head.appendChild(el2("span", TYPE_LABEL[e.failure_type] || e.failure_type, "font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      right.appendChild(head);
      right.appendChild(el2("div", e.reason, "font-size:13px;color:var(--dsw-alias-state-danger-primary,#e5534b);word-break:break-all;"));
      const raw = el2("pre", e.raw_error, "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:8px;padding:10px 12px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary,#9aa4b2);max-height:150px;overflow:auto;margin:0;cursor:pointer;");
      raw.addEventListener("click", () => {
        state.showRaw = !state.showRaw;
        raw.style.maxHeight = state.showRaw ? "150px" : "none";
      });
      right.appendChild(raw);
      const meta = el2("dl", void 0, "display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px;margin:0;");
      const put = (k, v) => {
        meta.appendChild(el2("dt", k, "color:var(--dsw-alias-label-secondary,#9aa4b2);"));
        meta.appendChild(el2("dd", v, "margin:0;color:var(--dsw-alias-label-secondary,#9aa4b2);word-break:break-all;"));
      };
      put("\u5931\u8D25\u7C7B\u578B", `${TYPE_LABEL[e.failure_type] || e.failure_type}\uFF08${e.failure_type}\uFF09`);
      put("\u7981\u7528\u65F6\u95F4", e.quarantined_at);
      put("profile", state.profile);
      put("patch \u6587\u4EF6", e.file);
      put("\u5305\u540D/\u6765\u6E90", e.name);
      right.appendChild(meta);
      const actions = el2("div", void 0, "display:flex;gap:8px;flex-wrap:wrap;");
      if (e.repairable) {
        const btn = el2("button", state.repairBusy === e.id ? "\u4FEE\u590D\u4E2D\u2026" : "\u4FEE\u590D");
        if (state.repairBusy === e.id) btn.setAttribute("disabled", "true");
        btn.className = "pf-btn ghost";
        btn.addEventListener("click", () => void doRepair(e.id));
        actions.appendChild(btn);
      }
      const ai = el2("button", state.explain[e.id] === "loading" ? "AI \u89E3\u8BFB\u4E2D\u2026" : "AI \u89E3\u8BFB");
      ai.className = "pf-btn ghost";
      ai.addEventListener("click", () => void doExplain(e.id));
      actions.appendChild(ai);
      const restore = el2("button", "\u6062\u590D");
      restore.className = "pf-btn danger";
      restore.addEventListener("click", () => void askRestore(e.id));
      actions.appendChild(restore);
      right.appendChild(actions);
      const st = state.explain[e.id];
      if (state.repairMsg) {
        right.appendChild(el2("div", state.repairMsg.text, `font-size:12px;white-space:pre-wrap;border:1px solid ${state.repairMsg.ok ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-state-danger-primary,#e5534b)"};border-radius:12px;padding:10px 14px;word-break:break-all;`));
      }
      if (st === "loading") {
        right.appendChild(el2("div", "AI \u89E3\u8BFB\u4E2D\u2026\uFF08deepseek-v4-flash\uFF09", "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      } else if (typeof st === "string") {
        right.appendChild(el2("div", `AI \u89E3\u8BFB \xB7 \u4EC5\u4F9B\u53C2\u8003`, "font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:4px;"));
        right.appendChild(el2("div", st, "font-size:12.5px;white-space:pre-wrap;border:1px solid var(--dsw-alias-brand-primary-new-color,#4176e6);border-radius:12px;padding:12px 14px;"));
      }
      right.appendChild(el2("div", "\u6062\u590D / \u4FEE\u590D\u53EA\u6539 patch \u6587\u4EF6\u4E0E\u53F0\u8D26\uFF0C\u91CD\u542F dsh \u540E\u751F\u6548\u3002", "font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    }
    wrap.appendChild(right);
    root.appendChild(wrap);
  }
  async function loadProviderDir() {
    if (!fuseConnection) {
      state.providerDir = { error: "connection \u4E0D\u53EF\u7528\uFF08\u975E\u684C\u9762\u58F3\u73AF\u5883\uFF09" };
      return;
    }
    state.providerDir = "loading";
    try {
      const r = await fuseConnection.rpc.call("/dsh-desktop-models", "list", {});
      if (!r?.ok) throw new Error(r?.error?.message ?? "models \u67E5\u8BE2\u5931\u8D25");
      const providers = r.value?.providers ?? [];
      state.providerDir = providers.map((p) => ({
        id: p.id,
        name: p.name,
        settingsNs: "",
        models: p.models || []
      }));
    } catch (err) {
      state.providerDir = { error: String(err) };
    }
  }
  async function runDoctor() {
    if (state.doctor === "running") return;
    state.doctor = "running";
    state.doctorError = null;
    render();
    try {
      const r = await invoke4("run_doctor");
      state.doctor = r.checks;
      console.info("[plugin-fuse] run_doctor \u5B8C\u6210\uFF1A", Array.isArray(r.checks) ? `${r.checks.length} \u9879` : JSON.stringify(r));
    } catch (err) {
      state.doctor = "idle";
      state.doctorError = String(err);
      console.error("[plugin-fuse] run_doctor \u5931\u8D25\uFF1A", err);
      root.appendChild(el2("div", `\u4F53\u68C0\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
    render();
  }
  async function doRepair(id) {
    if (state.repairBusy) return;
    state.repairBusy = id;
    state.repairMsg = { ok: true, text: "\u4FEE\u590D\u5DF2\u6D3E\u53D1\uFF1Adsh plugin add @latest \u5B89\u88C5\u4E2D\uFF0C\u901A\u5E38\u9700 10\u201330 \u79D2\uFF0C\u8BF7\u52FF\u5173\u95ED\u8BBE\u7F6E\u2026" };
    render();
    try {
      const r = await invoke4("repair_plugin", { id });
      state.repairMsg = { ok: !!r.ok, text: r.ok ? r.message ?? "\u4FEE\u590D\u5B8C\u6210\uFF0C\u91CD\u542F dsh \u540E\u751F\u6548" : `\u4FEE\u590D\u5931\u8D25\uFF1A${r.error ?? "\u672A\u77E5"}` };
    } catch (err) {
      state.repairMsg = { ok: false, text: `\u4FEE\u590D\u5931\u8D25\uFF1A${String(err)}` };
    }
    state.repairBusy = null;
    await reload();
    render();
  }
  async function doExplain(id) {
    if (state.explain[id] === "loading") return;
    state.explain[id] = "loading";
    render();
    try {
      const r = await invoke4("explain_failure", { id });
      state.explain[id] = r.ok && r.suggestion ? r.suggestion : `AI \u89E3\u8BFB\u4E0D\u53EF\u7528\uFF1A${r.error ?? "\u672A\u77E5"}`;
    } catch (err) {
      state.explain[id] = `AI \u89E3\u8BFB\u4E0D\u53EF\u7528\uFF1A${String(err)}`;
    }
    render();
  }
  async function askRestore(id) {
    if (!window.confirm(`\u6062\u590D ${id}\uFF1F

\u5C06\u4ECE cordis.patch.yml \u6258\u7BA1\u533A\u5757\u79FB\u9664 disabled: true \u884C\uFF0C\u6062\u590D\u540E\u5C06\u5728\u4E0B\u6B21\u91CD\u542F\u65F6\u751F\u6548\u3002\u82E5\u65B0\u7248\u672C dsh \u4ECD\u4E0D\u517C\u5BB9\uFF0C\u4E0B\u6B21\u542F\u52A8\u4F1A\u518D\u6B21\u88AB\u81EA\u52A8\u9694\u79BB\u3002`)) return;
    try {
      await invoke4("restore_quarantine", { ids: [id] });
      await reload();
      render();
    } catch (err) {
      root.appendChild(el2("div", `\u6062\u590D\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
  }
  async function saveSettings() {
    if (!state.settings) return;
    try {
      const r = await fuseConnection.rpc.call("/dsh-desktop-fuse-settings", "save", {
        patch: {
          quarantine_first_party_protection: state.settings.first_party_protection,
          quarantine_exclude: state.settings.exclude,
          quarantine_max_retries: state.settings.max_retries,
          ai_provider: state.settings.ai_provider || "deepseek",
          ai_model: state.settings.ai_model || ""
        }
      });
      if (!r?.ok) throw new Error(r?.error?.message ?? "\u4FDD\u5B58\u88AB\u62D2\u7EDD");
    } catch (err) {
      root.appendChild(el2("div", `\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
    render();
  }
  void (async () => {
    await Promise.all([reload(), loadSummary()]);
    void loadProviderDir().then(() => render());
    try {
      const r = await fuseConnection.rpc.call("/dsh-desktop-fuse-settings", "get", {});
      if (r.ok && r.value && typeof r.value === "object") {
        const v = r.value;
        state.settings = {
          first_party_protection: v.quarantine_first_party_protection ?? true,
          exclude: v.quarantine_exclude ?? [],
          max_retries: v.quarantine_max_retries ?? 2,
          ai_provider: v.ai_provider ?? "deepseek",
          ai_model: v.ai_model ?? "",
          ai_base_url: v.ai_base_url ?? "",
          ai_key_env: v.ai_key_env ?? ""
        };
      }
    } catch {
      state.settings = {
        first_party_protection: true,
        exclude: [],
        max_retries: 2,
        ai_provider: "deepseek",
        ai_model: "",
        ai_base_url: "",
        ai_key_env: ""
      };
    }
    render();
  })();
  render();
  return root;
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
  return { mode: env.mode, platform: env.platform };
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
  installExternalLinkHandler();
  registerDownloadsTab(ctx);
  installDownloadInterceptor();
  registerDesktopSettings(ctx);
  registerFusePanel(ctx);
  void requestDesktopClientEnvironment().then((environment) => {
    if (environment?.mode === "advanced") applyAdvancedShell(ctx, environment);
  }).catch(() => {
  });
}
return module.exports;
  }
});

//# sourceMappingURL=client.js.map
