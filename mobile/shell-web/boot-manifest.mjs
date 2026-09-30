// 手机壳的「文档组装」核心（纯字符串逻辑、可单测）：远程 HTML → 壳内页面。
//
// 三件事（形态与桌面 `network/shell_origin/scheme.rs` 同构，规则取自 2026-09-29 抓的真实页面）：
//   ① **剥掉 lane 的页面补丁**（`data-dsh-mobile-owns-host` / `theme-sync` / `loopback`）——
//      远程 HTML 是从 lane 取回来的，那些补丁是 lane 给它**自己 origin** 准备的；在壳内页面上
//      它们会把回环地址改写成 `/_loopback/…`，把 mux WS 改坏（桌面踩过：`connection lost, retry #N`）。
//   ② `__DSH_BOOT__` 启动图的**增补**：随包的布局插件不在 Host 的 `dsh.client` 扫描结果里，
//      而「装载 ≠ 激活」——必须往启动图里补一行 entry + 一个 application batch，
//      否则插件 factory 注册了也永远不会 `apply(ctx)`（#150 §3 的证据链）。
//   ③ `<base href="./">` 的处置：壳内页面的 origin 就是壳自己的 loopback 服务，`./` 天然正确，
//      所以**只在它指向绝对地址时才改写**（不像桌面必须重写成代理 origin）。
//
// 页面本体（`<head>`/`<body>` 的启动注入、模块加载器 facade、`__DSH_BOOT__`）一律原样保留：
// 那些是 Host 运行时的真实状态，壳只做上面三件事。

/** 需要剥掉的 lane 页面补丁标记（与桌面 `scheme.rs::drop_lane_patches` 同一份清单）。 */
export const LANE_PATCH_MARKERS = [
  'data-dsh-mobile-owns-host',
  'data-dsh-mobile-theme-sync',
  'data-dsh-mobile-loopback',
];

/** 剥掉 lane 的页面级补丁 `<script>`（连带标签）。 */
export function stripLanePatches(html) {
  let out = String(html ?? '');
  for (const marker of LANE_PATCH_MARKERS) {
    let at = out.indexOf(marker);
    while (at >= 0) {
      const start = out.lastIndexOf('<script', at);
      const close = out.indexOf('</script>', at);
      if (start < 0 || close < 0) {
        // 形状不认识就只摘标记本身，绝不猜范围。
        out = out.slice(0, at) + out.slice(at + marker.length);
      } else {
        out = out.slice(0, start) + out.slice(close + '</script>'.length);
      }
      at = out.indexOf(marker);
    }
  }
  return out;
}

/** 启动图在页面里的嵌入前缀（2026-09-29 抓的真实页面：`<script>globalThis["__DSH_BOOT__"] = {…}</script>`）。 */
const BOOT_PREFIX = 'globalThis["__DSH_BOOT__"]';
const BOOT_PREFIX_ALT = "globalThis['__DSH_BOOT__']";

/**
 * 从 HTML 里取出启动图对象与其在文本中的 JSON 区间。
 * @returns {{ graph:object, start:number, end:number } | null}
 */
export function readBootGraph(html) {
  const s = String(html ?? '');
  let base = s.indexOf(BOOT_PREFIX);
  let prefixLen = BOOT_PREFIX.length;
  if (base < 0) {
    base = s.indexOf(BOOT_PREFIX_ALT);
    prefixLen = BOOT_PREFIX_ALT.length;
  }
  if (base < 0) return null;
  const eq = s.indexOf('=', base + prefixLen);
  if (eq < 0) return null;
  const start = s.indexOf('{', eq);
  if (start < 0) return null;
  const end = matchBrace(s, start);
  if (end < 0) return null;
  try {
    return { graph: JSON.parse(s.slice(start, end + 1)), start, end };
  } catch {
    return null;
  }
}

/** 从 `{` 起做字符串感知的括号配对，返回匹到的 `}` 下标（找不到 -1）。 */
function matchBrace(s, open) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i += 1;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 往启动图里增补一个随包插件：一行 entry + 一个独占的 application batch。
 *
 * 规则逐条对齐 `dsh-client-modules` 的 `parseBootManifest`（#150 §3 已逐行核对）：
 * - entry：`{ id, url, rev, inject?, external?, immediately? }`，`id` 不得重复；
 * - **每个 entry 必须属于恰好一个 batch**，否则前端抛 `belongs to no initial-load batch`；
 * - batch：`{ phase:'application', url, rev, entries:[…] }`，`url` 不得重复、`entries` 非空且 id 已知。
 *
 * @param {object} graph 原启动图（会被复制，不原地改）
 * @param {{ id:string, url:string, rev:string, inject?:string[] }} plugin
 * @returns {{ graph:object, added:boolean, reason?:string }}
 */
export function augmentBootGraph(graph, plugin) {
  const g = graph && typeof graph === 'object' ? graph : null;
  if (!g) return { graph: g, added: false, reason: '启动图缺失或形状不符' };
  if (!plugin?.id || !plugin?.url) return { graph: g, added: false, reason: '插件 id/url 缺失' };
  const entries = Array.isArray(g.entries) ? g.entries.slice() : [];
  const batches = Array.isArray(g.batches) ? g.batches.slice() : [];
  if (entries.some((e) => e?.id === plugin.id)) {
    // 已经有一行（Host 自己也装了它）：不动，直接用 Host 的图（#152 决策 5 的默认分支）。
    return { graph: g, added: false, reason: '启动图里已有同 id 的 entry（走 Host 自己的那份）' };
  }
  if (batches.some((b) => b?.url === plugin.url)) {
    return { graph: g, added: false, reason: '启动图里已有同 url 的 batch' };
  }
  const entry = { id: plugin.id, url: plugin.url, rev: String(plugin.rev ?? '') };
  if (Array.isArray(plugin.inject) && plugin.inject.length > 0) entry.inject = plugin.inject.slice();
  if (plugin.immediately === true) entry.immediately = true;
  entries.push(entry);
  batches.push({
    phase: 'application',
    url: plugin.url,
    rev: String(plugin.rev ?? ''),
    entries: [plugin.id],
  });
  return { graph: { ...g, entries, batches }, added: true };
}

/** 把启动图写回 HTML（替换原 JSON 区间）。 */
export function writeBootGraph(html, located, graph) {
  const s = String(html ?? '');
  if (!located) return s;
  return s.slice(0, located.start) + JSON.stringify(graph) + s.slice(located.end + 1);
}

/**
 * 组装壳内页面：远程 HTML → 剥 lane 补丁 → （可选）增补随包插件 → 写回。
 *
 * @param {{ remoteHtml:string, localPlugin?:object|null }} input
 * @returns {{ html:string, stripped:boolean, bootAdded:boolean, bootReason?:string }}
 */
export function composeDocument({ remoteHtml, localPlugin = null } = {}) {
  const raw = String(remoteHtml ?? '');
  const stripped = LANE_PATCH_MARKERS.some((m) => raw.includes(m));
  let html = stripLanePatches(raw);
  let bootAdded = false;
  let bootReason;
  if (localPlugin?.id && localPlugin?.url) {
    const located = readBootGraph(html);
    const { graph, added, reason } = augmentBootGraph(located?.graph, localPlugin);
    if (added) {
      html = writeBootGraph(html, located, graph);
      bootAdded = true;
    } else {
      bootReason = reason;
    }
  }
  return { html, stripped, bootAdded, bootReason };
}
