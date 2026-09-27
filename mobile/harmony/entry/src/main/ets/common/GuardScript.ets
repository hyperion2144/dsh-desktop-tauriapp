/**
 * 页面探针脚本（#67）。
 *
 * 壳侧无法直接拿到 ArkWeb 内部由页面 JS 创建的 WebSocket 句柄，只能通过
 * `controller.runJavaScript()` 在页面上下文里问一句「你还活着吗」。脚本必须：
 *  - 是**幂等**的：反复注入不产生副作用，不污染页面全局状态；
 *  - 有**超时**：ArkWeb 被系统挂起时页面 JS 不执行，靠 Promise 竞速兜底；
 *  - 只回**单行文本**：`runJavaScript` 的返回值是字符串，解析必须够硬。
 *
 * 返回值契约（与 `SessionGuard` 的 `ProbeReading` 一一对应）：
 *  - `ds|1|u`  页面在线（`__DSH_BOOT__` 存在）
 *  - `ds|0|u`  页面上下文在，但 dsh 客户端没起来（导航中 / 白屏）
 *  - `off|0|u` `navigator.onLine` 为 false（无网络，重载没意义）
 *  - `null|0|u` fetch 超时 / 无网络栈（需要重载）
 *  - `err|0|u` fetch 抛异常（DNS / 拒绝连接，需要重载）
 *
 * 第三段是页面侧 WebSocket 状态（诊断用，不参与判定）：dsh 主包不在全局保留
 * 连接句柄（`RemoteStreamCarrier` 是闭包内部的类，`__ModuleLoader__` 也取不到实例），
 * 壳侧诚实报 `-`，不去猜。「服务端已判死而页面以为还活着」这条线索改由
 * `parseGuardProbeResult` 的兜底重载覆盖，不依赖状态直读。
 */

/** 探针等待页面应答的超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 1200;

/**
 * 生成探针脚本。
 *
 * @param timeoutMs 页面内 Promise 竞速的超时，需小于壳侧等待时间
 * @returns 可直接交给 `controller.runJavaScript()` 的单行脚本
 */
export function buildGuardProbeScript(timeoutMs: number = PROBE_TIMEOUT_MS): string {
  return '(function(){'
    + 'var done=false;'
    + 'function out(s){return s+"|"+(navigator.onLine?1:0)+"|"+sock();}'
    + 'function sock(){'
    + 'try{'
    + 'function sock(){return "-";}'
    + 'return new Promise(function(res){'
    + 'var fin=function(s){if(!done){done=true;res(out(s));}};'
    + 'setTimeout(function(){fin("null");},' + timeoutMs + ');'
    + 'try{'
    + 'fetch(location.origin+"/api/remote.mux",{method:"GET",cache:"no-store"})'
    + '.then(function(r){fin(globalThis.__DSH_BOOT__?"ds":"ds0");})'
    + '.catch(function(){fin("err");});'
    + '}catch(_){fin("err");}'
    + '});'
    + '})()';
}

/**
 * 解析页面探针返回值。
 *
 * 解析失败一律返回 `null`——「读不到页面状态」与「页面状态是坏的」都要求重载，
 * 因此不需要区分，但绝不能把解析失败误判成健康（那会让半开连接永远不被修复）。
 *
 * @param raw `runJavaScript` 的原始返回
 * @returns 成功时为 `信号|在线|套接字`，否则 null
 */
export function parseGuardProbeResult(raw: string): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/^"|"$/g, '');
  if (text.length === 0) return null;
  const match = /^(ds0?|off|null|err)\|([01])\|(\S+)$/.exec(text);
  if (match === null) return null;
  return match[1] + '|' + match[2] + '|' + match[3];
}

/**
 * 会话守卫的判定/退避/脚本（语义源：`mobile/shell-web/session-guard.mjs`，改那里必须同步这里）。
 *
 * 维护者 2026-09-27 拍板「都走 B」：回前台/网络换代一律先做**页面内轻量重连**，
 * 整页重载只在「页面已无法执行脚本」的形态下用（探针读不到/读数残缺/渲染崩溃）。
 */
export enum GuardAction {
  NONE = 'none',
  WAIT_NETWORK = 'wait-network',
  RECONNECT = 'reconnect',
  RELOAD = 'reload'
}

/** 连续这么多次轻量重连仍不健康 → 升级为兜底整页重载。 */
export const RELOAD_AFTER_RECONNECT_FAILURES = 3;
/** 连续失败第几次开始退避。 */
export const BACKOFF_AFTER_FAILURES = 2;
/** 退避基数（毫秒）。 */
export const BACKOFF_BASE_MS = 2000;
/** 退避上限（毫秒）。 */
export const BACKOFF_CAP_MS = 30000;

/** 第 failures 次连续失败后的退避时长（毫秒）。 */
export function backoffDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < BACKOFF_AFTER_FAILURES) return 0;
  const step = failures - BACKOFF_AFTER_FAILURES;
  const raw = BACKOFF_BASE_MS * Math.pow(2, step);
  return raw > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : raw;
}

/**
 * 判定读数对应的动作（语义源同上 `actionForReading`）。
 * `ds` 健康；`off` 设备没网等网络事件；`ds0`/`err` 轻量重连；
 * `null` **页面回了消息**但它的探测请求超时 → 轻量重连（能回消息就证明页面活着；
 * 把它当“读不到”会让 iPad 每 20s 假重载一次，已实机回归）；其余（完全没回消息/残缺）→ 兜底重载。
 */
export function actionForReading(reading: string | null): GuardAction {
  if (reading === null || reading === undefined) return GuardAction.RELOAD;
  const signal = reading.split('|')[0];
  if (signal === 'ds') return GuardAction.NONE;
  if (signal === 'off') return GuardAction.WAIT_NETWORK;
  if (signal === 'ds0' || signal === 'err' || signal === 'null') return GuardAction.RECONNECT;
  return GuardAction.RELOAD;
}

/** 轻量重连是否应升级为兜底重载。 */
export function shouldEscalateToReload(failures: number, reconnects: number): boolean {
  return failures >= RELOAD_AFTER_RECONNECT_FAILURES && reconnects >= RELOAD_AFTER_RECONNECT_FAILURES;
}

/**
 * 页面内轻量重连脚本（语义源同上 `buildLightReconnectScript`）。
 *
 * dsh 客户端按 offline/online 事件管理重连：`offline` 中止活动工作并暂停自动重试，随后 `online`
 * 重置序列、从 500ms 档重试，且每次重试前取消候选/活动 socket 做一次全新物理连接。
 */
export function buildLightReconnectScript(): string {
  return '(function(){try{'
    + 'var fire=function(t){try{window.dispatchEvent(new Event(t));}catch(e){}};'
    + 'fire("offline");fire("online");'
    + 'return "ok";'
    + '}catch(e){return "err";}})()';
}
