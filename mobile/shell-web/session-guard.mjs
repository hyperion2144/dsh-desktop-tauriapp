// 移动端「连接半死」会话守卫的纯逻辑源（#144）。
//
// 为什么需要它：dsh 0.1.7 起网关对 `/api/remote.mux` 每 2s 发 Ping、连丢 2 次即 terminate；
// 被系统挂起的 WebView（iOS 切后台、鸿蒙挂起）数秒内就会被判死，而页面常常收不到 close/error，
// 于是「能发消息（HTTP POST 每次新建连接）、收不到新消息（mux 下行已死）」。
//
// 修复顺序（维护者 2026-09-27 拍板「都走 B」）：
//   1. 页面内**轻量重连**：先让 dsh 客户端重连（offline→online 事件对，官方恢复路径），不整页重载；
//   2. 连续多次轻量重连无效 → 才整页重载（**仅**当页面已无法执行脚本/白屏时立即重载）。
//   整页重载从「回前台/网络换代」的常规路径里彻底移除：那会丢掉页面状态、每次切 App 都整页重来。
//
// 本文件是**唯一逻辑源**：鸿蒙壳（ArkTS）与 expo 壳（TS）按其语义移植。改这里必须同步两端。
// 契约（与两端的探针/注入保持一致）：
//   - 探针读数 = `信号|在线|套接字`，信号 ∈ {ds, ds0, off, null, err}；解析失败一律 null（按需修复）。
//   - 动作 ∈ {none, wait-network, reconnect, reload}；轻量重连与兜底重载都走同一套退避与静默期。

/** 探针在页面内的等待上限（毫秒）；壳侧等待应显著大于它。 */
export const GUARD_PROBE_TIMEOUT_MS = 1200;

/** 连续失败第几次开始退避（前几次直接修，避免把偶发超时拖成慢性病）。 */
export const BACKOFF_AFTER_FAILURES = 2;

/** 退避步长基数（毫秒）：第 n 次失败等待 `BASE * 2^(n-2)`。 */
export const BACKOFF_BASE_MS = 2000;

/** 退避上限（毫秒）。 */
export const BACKOFF_CAP_MS = 30000;

/** 一次修复动作（轻量重连或兜底重载）之后的静默期（毫秒），期内跳过判定。 */
export const SETTLE_AFTER_REPAIR_MS = 5000;

/** 连续这么多次轻量重连仍不健康 → 升级为兜底整页重载。 */
export const RELOAD_AFTER_RECONNECT_FAILURES = 3;

/** 合法信号集合（探针契约的一部分，两端共用）。 */
export const READING_SIGNALS = Object.freeze(['ds', 'ds0', 'off', 'null', 'err']);

/** 会话守卫的动作（纯取值，便于两端枚举一一对应）。 */
export const GUARD_ACTION = Object.freeze({
  NONE: 'none',
  WAIT_NETWORK: 'wait-network',
  RECONNECT: 'reconnect',
  RELOAD: 'reload',
});

/** 第 `failures` 次连续失败后的退避时长（毫秒）；未达阈值返回 0。 */
export function backoffDelayMs(failures) {
  const n = Number(failures);
  if (!Number.isFinite(n) || n < BACKOFF_AFTER_FAILURES) return 0;
  const step = n - BACKOFF_AFTER_FAILURES;
  const raw = BACKOFF_BASE_MS * Math.pow(2, step);
  return raw > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : raw;
}

/**
 * 解析探针返回值（`信号|在线|套接字`）。
 *
 * 解析失败一律返回 `null`——「读不到页面状态」与「页面状态是坏的」都要求修复，
 * 但绝不能把解析失败误判成健康（那会让半开连接永远不被修）。
 */
export function parseGuardProbeResult(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/^"|"$/g, '');
  if (text.length === 0) return null;
  const match = /^(ds0?|off|null|err)\|([01])\|(\S+)$/.exec(text);
  if (match === null) return null;
  return match[1] + '|' + match[2] + '|' + match[3];
}

/**
 * 读数 → 动作（纯函数，两端的判定必须完全一致）。
 *
 * - `ds`  页面已启动且探针可达 → 不动手
 * - `off` 页面自己说没网 → 等网络恢复事件（重连/重载都没意义）
 * - `ds0` 页面在、客户端没起来 → 轻量重连（不再整页重载）
 * - `err` 页面在、探针请求失败 → 轻量重连
 * - 其它（含解析失败）→ 页面可能已无法执行脚本 → 兜底重载
 *
 * 需要「页面完全无法执行脚本且连探针都投不进去」的判定由壳侧承担：注入失败同样传 `null`。
 */
export function actionForReading(reading) {
  // 先过解析：判定只接受完整读数，残缺/异常的输入一律按「页面可能已无法执行脚本」处理，
  // 免得一个残缺字符串（例如只有 "ds"）被当成健康。
  const parsed = parseGuardProbeResult(reading);
  if (parsed === null) return GUARD_ACTION.RELOAD;
  const signal = parsed.split('|')[0];
  if (signal === 'ds') return GUARD_ACTION.NONE;
  if (signal === 'off') return GUARD_ACTION.WAIT_NETWORK;
  if (signal === 'ds0' || signal === 'err') return GUARD_ACTION.RECONNECT;
  return GUARD_ACTION.RELOAD;
}

/**
 * 轻量重连是否应升级为兜底重载（纯函数）。
 *
 * @param failures 连续失败次数
 * @param reconnects 连续轻量重连次数（一次健康探针清零）
 */
export function shouldEscalateToReload(failures, reconnects) {
  return Number(failures) >= RELOAD_AFTER_RECONNECT_FAILURES
    && Number(reconnects) >= RELOAD_AFTER_RECONNECT_FAILURES;
}

/**
 * 生成页面内探针脚本（单行，供 runJavaScript / injectJavaScript 使用）。
 *
 * 语义：`fetch(location.origin + "/api/remote.mux")` 只要拿到响应就说明「页面在、链路通」，
 * 再用 `__DSH_BOOT__` 区分客户端是否已启动（dsh 0.1.7-rc.2 前端仍带该标记）。
 */
export function buildGuardProbeScript(timeoutMs = GUARD_PROBE_TIMEOUT_MS) {
  return '(function(){'
    + 'var done=false;'
    + 'function out(s){return s+"|"+(navigator.onLine?1:0)+"|"+sock();}'
    + 'function sock(){'
    + 'try{return (performance&&performance.now)?Math.round(performance.now()):"-";}catch(e){return "-";}'
    + '}'
    + 'return new Promise(function(res){'
    + 'var fin=function(s){if(!done){done=true;res(out(s));}};'
    + 'setTimeout(function(){fin("null");},' + timeoutMs + ');'
    + 'try{'
    + 'fetch(location.origin+"/api/remote.mux",{method:"GET",cache:"no-store"})'
    + '.then(function(){fin(globalThis.__DSH_BOOT__?"ds":"ds0");})'
    + '.catch(function(){fin("err");});'
    + '}catch(e){fin("err");}'
    + '});'
    + '})()';
}

/**
 * 生成页面内「轻量重连」脚本（单行）。
 *
 * dsh 客户端按浏览器 `offline`/`online` 事件管理重连：`offline` 中止活动工作并暂停自动重试，
 * 随后的 `online` 重置序列、从 500ms 档重试，且每次重试前会取消候选/活动 socket 并做一次
 * 全新的物理连接——这正是「不整页重载也能把死掉的 mux 重新拉起来」的官方路径。
 * 事件对同步派发，避免页面在离线态停留。
 */
export function buildLightReconnectScript() {
  return '(function(){try{'
    + 'var fire=function(t){try{window.dispatchEvent(new Event(t));}catch(e){}};'
    + 'fire("offline");fire("online");'
    + 'return "ok";'
    + '}catch(e){return "err";}})()';
}

/**
 * 生成「探针 + 回传」脚本（供 React Native WebView 使用：injectJavaScript 无返回值，
 * 读数必须经 postMessage 回到壳侧）。标签固定为 `DSH_GUARD:`，壳侧按前缀解析。
 */
export const GUARD_MESSAGE_PREFIX = 'DSH_GUARD:';

export function buildGuardProbeWithPostMessageScript(timeoutMs = GUARD_PROBE_TIMEOUT_MS) {
  const probe = buildGuardProbeScript(timeoutMs);
  return '(function(){'
    + 'function post(v){try{window.ReactNativeWebView.postMessage("' + GUARD_MESSAGE_PREFIX + '"+v);}catch(e){}}'
    + 'try{'
    + 'Promise.resolve(' + probe + ').then(function(v){post(String(v));},function(){post("null");});'
    + '}catch(e){post("null");}'
    + 'return true;'
    + '})()';
}
