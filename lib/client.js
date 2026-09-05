window.__ModuleLoader__.load({
  id: "dsh-desktop-tauriapp",
  factory: (require) => {
var module = { exports: {} };
var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
  const children = Array.from(frame.children).filter((el) => el instanceof HTMLElement);
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
  const refreshStatus = () => {
    const invoke = tauriInvoke2();
    if (!invoke) return;
    void invoke("get_dsh_status", {}).then((value) => {
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
      if (found.center !== null) found.center.style.paddingTop = "";
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
.dshDesktopChromeDrag { user-select: none; }
.dshDesktopStatusBar { position: absolute; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary, currentColor); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); pointer-events: auto; user-select: none; }
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
  const invoke = tauriInvoke();
  if (!invoke) return;
  invoke("log_diag", { msg }).catch(() => {
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
  const invoke = tauriInvoke();
  if (invoke) {
    invoke("open_external", { url }).then(() => {
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
    const el = event.target;
    const anchor = el?.closest?.("a");
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
  const invoke = (cmd, args) => {
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
      invoke("log_console", { level, msg, pageUrl: url });
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
  void requestDesktopClientEnvironment().then((environment) => {
    if (environment?.mode === "advanced") applyAdvancedShell(ctx, environment);
  }).catch(() => {
  });
}
return module.exports;
  }
});

//# sourceMappingURL=client.js.map
