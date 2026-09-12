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
  const children = Array.from(frame.children).filter((el2) => el2 instanceof HTMLElement);
  return { frame, sidebar: children[0] ?? frame, center: children[1] ?? null };
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
    const invoke2 = tauriInvoke2();
    if (!invoke2) return;
    void invoke2("get_dsh_status", {}).then((value) => {
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
  const isScrollableY = (el2) => {
    const oy = getComputedStyle(el2).overflowY;
    return oy === "auto" || oy === "scroll";
  };
  const ensureSidebarScroll = (sidebar) => {
    let root = null;
    const slot = document.querySelector('[data-slot="sidebar"]');
    if (slot !== null) {
      root = Array.from(slot.children).find((el2) => el2 instanceof HTMLElement) ?? null;
    }
    if (root === null) {
      root = Array.from(sidebar.children).find((el2) => el2 instanceof HTMLElement) ?? null;
    }
    if (root === null) return;
    root.style.flexWrap = "nowrap";
    root.style.width = "100%";
    root.style.maxWidth = "100%";
    root.style.minWidth = "0";
    root.style.overflowX = "auto";
    scrollRoot = root;
    const region = Array.from(root.children).find((el2) => {
      return el2 instanceof HTMLElement && getComputedStyle(el2).flexGrow === "1";
    });
    if (region === void 0) return;
    scrollRegion = region;
    minWidthPatched.length = 0;
    const visit = (el2) => {
      const style = getComputedStyle(el2);
      if (style.display.includes("flex")) {
        el2.style.minWidth = "0";
        minWidthPatched.push(el2);
      }
      if (isScrollableY(el2)) {
        el2.style.overflowX = "auto";
        overflowXPatched.push(el2);
      }
      for (const child of el2.children) {
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
    const { frame, sidebar, center } = layout;
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
    }
    if (mutationObserver !== null) {
      mutationObserver.observe(layout.frame, {
        attributes: true,
        attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed", "style"]
      });
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
    }
    for (const el2 of minWidthPatched) el2.style.minWidth = "";
    for (const el2 of overflowXPatched) el2.style.overflowX = "";
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
  const invoke2 = tauriInvoke();
  if (!invoke2) return;
  invoke2("log_diag", { msg }).catch(() => {
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
  const invoke2 = tauriInvoke();
  if (invoke2) {
    invoke2("open_external", { url }).then(() => {
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
    const el2 = event.target;
    const anchor = el2?.closest?.("a");
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

// src/client/plugin-fuse.ts
var import_react = __toESM(require("react"), 1);
function hasIpc() {
  const w = window;
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}
function invoke(cmd, args) {
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
function el(tag, text, style) {
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
function registerFusePanel(ctx) {
  if (!hasIpc()) {
    ctx?.logger?.warn?.("plugin-fuse: \u65E0 Tauri IPC\uFF08\u7EAF\u6D4F\u89C8\u5668\uFF09\uFF0C\u8DF3\u8FC7\u8BBE\u7F6E\u5165\u53E3");
    return;
  }
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
  const ref = import_react.default.useRef(null);
  import_react.default.useEffect(() => {
    const host = ref.current;
    if (!host || host.childNodes.length) return;
    let panel;
    try {
      panel = buildPanel();
    } catch (err) {
      panel = el("div", `\u63D2\u4EF6\u4FDD\u9669\u4E1D\u9762\u677F\u521D\u59CB\u5316\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;");
    }
    host.appendChild(panel);
    return () => {
      try {
        panel.remove();
      } catch {
      }
    };
  }, []);
  return import_react.default.createElement("div", { ref });
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
function buildPanel() {
  const state = {
    selected: 0,
    entries: [],
    profile: "web",
    doctor: null,
    explain: {},
    settings: null,
    showSettings: false,
    showRaw: true
  };
  const root = el("div", void 0, "display:flex;flex-direction:column;gap:12px;max-width:900px;font-size:13px;");
  root.dataset.pluginFuse = "1";
  ensurePanelStyles();
  async function reload() {
    try {
      const resp = await invoke("list_quarantine");
      state.profile = resp.profile;
      state.entries = resp.entries;
    } catch (err) {
      state.entries = [];
      root.appendChild(el("div", `\u8BFB\u53D6\u9694\u79BB\u540D\u5355\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
  }
  async function loadSummary() {
    try {
      const s = await invoke("get_fuse_summary");
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
    const wrap = el("div", void 0, "display:grid;grid-template-columns:264px 1fr;gap:16px;align-items:start;");
    const left = el("div", void 0, "display:flex;flex-direction:column;gap:12px;");
    const list = el("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;overflow:hidden;");
    if (!state.entries.length) {
      list.appendChild(el("div", "\u5F53\u524D\u6CA1\u6709\u88AB\u9694\u79BB\u7684\u63D2\u4EF6\u3002", "padding:14px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12.5px;"));
    }
    state.entries.forEach((e2, i) => {
      const row = el("div", void 0, `padding:11px 13px;border-bottom:1px solid var(--dsw-alias-border-l,#ffffff1f);cursor:pointer;${i === state.selected ? "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary-new-color,#4176e6);" : ""}`);
      row.className = "pf-row";
      const top = el("div", void 0, "display:flex;justify-content:space-between;gap:8px;align-items:center;");
      top.appendChild(el("b", e2.id, "font-size:12.5px;"));
      top.appendChild(el("span", TYPE_LABEL[e2.failure_type] || e2.failure_type, "font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap;"));
      row.appendChild(top);
      row.appendChild(el("div", e2.reason, "margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"));
      row.addEventListener("click", () => {
        state.selected = i;
        render();
      });
      list.appendChild(row);
    });
    left.appendChild(list);
    const doctorCard = el("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:12px 14px;");
    doctorCard.appendChild(el("b", "\u4F53\u68C0\uFF08doctor\uFF09", "font-size:12.5px;"));
    const doctorBody = el("div", void 0, "margin-top:8px;display:flex;flex-direction:column;gap:6px;");
    if (state.doctor === "idle" || state.doctor === null) {
      doctorBody.appendChild(el("div", "\u5C1A\u672A\u4F53\u68C0\uFF1A\u68C0\u67E5 dsh \u7248\u672C\u3001DSH_HOME\u3001profiles\u3001\u53F0\u8D26\u4E00\u81F4\u6027\u3001\u6258\u7BA1\u533A\u5757\u5065\u5EB7\u3002", "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    } else if (state.doctor === "running") {
      doctorBody.appendChild(el("div", "\u4F53\u68C0\u4E2D\u2026", "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    } else {
      for (const c of state.doctor) {
        const row = el("div", void 0, "display:flex;gap:8px;align-items:flex-start;font-size:12px;");
        const dot = el("span", void 0, `width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;background:${c.ok ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-state-danger-primary,#e5534b)"};`);
        const text = el("div");
        text.appendChild(el("b", c.label, "font-size:12px;"));
        text.appendChild(el("div", c.detail, "font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
        row.append(dot, text);
        doctorBody.appendChild(row);
      }
    }
    const doctorBtn = el("button", state.doctor === "running" ? "\u4F53\u68C0\u4E2D\u2026" : "\u8FD0\u884C\u4F53\u68C0");
    doctorBtn.className = "pf-btn ghost";
    doctorBtn.style.marginTop = "8px";
    doctorBtn.addEventListener("click", () => void runDoctor());
    doctorCard.appendChild(doctorBody);
    doctorCard.appendChild(doctorBtn);
    left.appendChild(doctorCard);
    const setCard = el("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;overflow:hidden;");
    const setHead = el("div", void 0, "padding:11px 13px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:600;font-size:12.5px;");
    setHead.appendChild(el("span", "\u8BBE\u7F6E"));
    setHead.appendChild(el("span", state.showSettings ? "\u25BE" : "\u25B8", "color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    setHead.addEventListener("click", () => {
      state.showSettings = !state.showSettings;
      render();
    });
    setCard.appendChild(setHead);
    if (state.showSettings && state.settings) {
      const body = el("div", void 0, "padding:0 13px 12px;display:flex;flex-direction:column;gap:10px;font-size:12px;");
      const fpRow = el("div", void 0, "display:flex;justify-content:space-between;gap:10px;align-items:center;");
      fpRow.appendChild(el("span", "\u7B2C\u4E00\u65B9\u63D2\u4EF6\u4FDD\u62A4\uFF08@deepseek-ai/* \u4E0D\u81EA\u52A8\u7981\u7528\uFF09"));
      const sw = el("span", void 0, `position:relative;width:34px;height:19px;border-radius:999px;cursor:pointer;flex:none;background:${state.settings.first_party_protection ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-border-l,#ffffff1f)"};`);
      sw.style.cssText += `position:relative;`;
      const knob = el("span", void 0, `position:absolute;top:2px;left:${state.settings.first_party_protection ? "17px" : "2px"};width:15px;height:15px;border-radius:50%;background:#fff;`);
      sw.appendChild(knob);
      sw.addEventListener("click", () => {
        state.settings.first_party_protection = !state.settings.first_party_protection;
        void saveSettings();
      });
      fpRow.appendChild(sw);
      body.appendChild(fpRow);
      const rtRow = el("div", void 0, "display:flex;justify-content:space-between;gap:10px;align-items:center;");
      rtRow.appendChild(el("span", "\u542F\u52A8\u5931\u8D25\u6700\u5927\u91CD\u8BD5\u6B21\u6570"));
      const rt = el("span", void 0, "display:flex;gap:6px;align-items:center;");
      const minus = el("button", "\u2212");
      const plus = el("button", "\uFF0B");
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
      rt.append(minus, el("b", String(state.settings.max_retries)), plus);
      rtRow.appendChild(rt);
      body.appendChild(rtRow);
      const exclWrap = el("div");
      exclWrap.appendChild(el("div", "\u6392\u9664\u540D\u5355\uFF08\u6C38\u4E0D\u81EA\u52A8\u7981\u7528\uFF0C\u70B9\u51FB \u2715 \u79FB\u9664\uFF09", "margin-bottom:6px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      const chips = el("div", void 0, "display:flex;flex-wrap:wrap;gap:6px;");
      for (const x of state.settings.exclude) {
        const chip = el("span", `${x} \u2715`, "font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2);");
        chip.className = "pf-chip";
        chip.addEventListener("click", () => {
          state.settings.exclude = state.settings.exclude.filter((y) => y !== x);
          void saveSettings();
        });
        chips.appendChild(chip);
      }
      const addChip = el("span", "\uFF0B \u6DFB\u52A0", "font-size:11px;border:1px dashed var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2);");
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
      setCard.appendChild(body);
    }
    left.appendChild(setCard);
    wrap.appendChild(left);
    const right = el("div", void 0, "border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;align-self:start;min-height:220px;");
    const e = state.entries[Math.min(state.selected, Math.max(state.entries.length - 1, 0))];
    if (!e) {
      right.appendChild(el("div", "\u9009\u62E9\u5DE6\u4FA7\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5\u3002", "color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12.5px;"));
    } else {
      const head = el("div", void 0, "display:flex;justify-content:space-between;align-items:center;gap:8px;");
      head.appendChild(el("b", e.id, "font-size:14px;"));
      head.appendChild(el("span", TYPE_LABEL[e.failure_type] || e.failure_type, "font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      right.appendChild(head);
      right.appendChild(el("div", e.reason, "font-size:13px;color:var(--dsw-alias-state-danger-primary,#e5534b);word-break:break-all;"));
      const raw = el("pre", e.raw_error, "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:8px;padding:10px 12px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary,#9aa4b2);max-height:150px;overflow:auto;margin:0;cursor:pointer;");
      raw.addEventListener("click", () => {
        state.showRaw = !state.showRaw;
        raw.style.maxHeight = state.showRaw ? "150px" : "none";
      });
      right.appendChild(raw);
      const meta = el("dl", void 0, "display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px;margin:0;");
      const put = (k, v) => {
        meta.appendChild(el("dt", k, "color:var(--dsw-alias-label-secondary,#9aa4b2);"));
        meta.appendChild(el("dd", v, "margin:0;color:var(--dsw-alias-label-secondary,#9aa4b2);word-break:break-all;"));
      };
      put("\u5931\u8D25\u7C7B\u578B", `${TYPE_LABEL[e.failure_type] || e.failure_type}\uFF08${e.failure_type}\uFF09`);
      put("\u7981\u7528\u65F6\u95F4", e.quarantined_at);
      put("profile", state.profile);
      put("patch \u6587\u4EF6", e.file);
      put("\u5305\u540D/\u6765\u6E90", e.name);
      right.appendChild(meta);
      const actions = el("div", void 0, "display:flex;gap:8px;flex-wrap:wrap;");
      if (e.repairable) {
        const btn = el("button", "\u4FEE\u590D");
        btn.className = "pf-btn ghost";
        btn.addEventListener("click", () => void doRepair(e.id));
        actions.appendChild(btn);
      }
      const ai = el("button", state.explain[e.id] === "loading" ? "AI \u89E3\u8BFB\u4E2D\u2026" : "AI \u89E3\u8BFB");
      ai.className = "pf-btn ghost";
      ai.addEventListener("click", () => void doExplain(e.id));
      actions.appendChild(ai);
      const restore = el("button", "\u6062\u590D");
      restore.className = "pf-btn danger";
      restore.addEventListener("click", () => void askRestore(e.id));
      actions.appendChild(restore);
      right.appendChild(actions);
      const st = state.explain[e.id];
      if (st === "loading") {
        right.appendChild(el("div", "AI \u89E3\u8BFB\u4E2D\u2026\uFF08deepseek-v4-flash\uFF09", "font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
      } else if (typeof st === "string") {
        right.appendChild(el("div", `AI \u89E3\u8BFB \xB7 \u4EC5\u4F9B\u53C2\u8003`, "font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:4px;"));
        right.appendChild(el("div", st, "font-size:12.5px;white-space:pre-wrap;border:1px solid var(--dsw-alias-brand-primary-new-color,#4176e6);border-radius:12px;padding:12px 14px;"));
      }
      right.appendChild(el("div", "\u6062\u590D / \u4FEE\u590D\u53EA\u6539 patch \u6587\u4EF6\u4E0E\u53F0\u8D26\uFF0C\u91CD\u542F dsh \u540E\u751F\u6548\u3002", "font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);"));
    }
    wrap.appendChild(right);
    root.appendChild(wrap);
  }
  async function runDoctor() {
    if (state.doctor === "running") return;
    state.doctor = "running";
    render();
    try {
      const r = await invoke("run_doctor");
      state.doctor = r.checks;
    } catch (err) {
      state.doctor = "idle";
      root.appendChild(el("div", `\u4F53\u68C0\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
    render();
  }
  async function doRepair(id) {
    try {
      const r = await invoke("repair_plugin", { id });
      root.appendChild(el("div", r.ok ? `\u4FEE\u590D\u5B8C\u6210\uFF1A${r.message ?? ""}` : `\u4FEE\u590D\u5931\u8D25\uFF1A${r.error ?? ""}`, `font-size:12px;color:${r.ok ? "var(--dsw-alias-state-success-primary,#2fbf71)" : "var(--dsw-alias-state-danger-primary,#e5534b)"};`));
    } catch (err) {
      root.appendChild(el("div", `\u4FEE\u590D\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
    await reload();
    render();
  }
  async function doExplain(id) {
    if (state.explain[id] === "loading") return;
    state.explain[id] = "loading";
    render();
    try {
      const r = await invoke("explain_failure", { id });
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
      await invoke("restore_quarantine", { ids: [id] });
      await reload();
      render();
    } catch (err) {
      root.appendChild(el("div", `\u6062\u590D\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
  }
  async function saveSettings() {
    if (!state.settings) return;
    try {
      await invoke("save_quarantine_settings", {
        firstPartyProtection: state.settings.first_party_protection,
        exclude: state.settings.exclude,
        maxRetries: state.settings.max_retries
      });
    } catch (err) {
      root.appendChild(el("div", `\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF1A${String(err)}`, "color:#e5534b;font-size:12px;"));
    }
    render();
  }
  void (async () => {
    await Promise.all([reload(), loadSummary()]);
    try {
      state.settings = await invoke("get_quarantine_settings");
    } catch {
      state.settings = { first_party_protection: true, exclude: [], max_retries: 2 };
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
  "workspaces"
];
function installWebviewConsoleMirror() {
  const w = window;
  const invoke2 = (cmd, args) => {
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
      invoke2("log_console", { level, msg, pageUrl: url });
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
