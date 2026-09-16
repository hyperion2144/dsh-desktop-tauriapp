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
 * 判定一次探针读数是否需要壳侧介入重载。
 *
 * `ds`（dsh 客户端在线）是唯一健康信号：`ds0` 表示页面在但客户端没起来，
 * 同样需要重载；`off` 表示设备没网，重载也无济于事，等网络恢复事件再处理。
 *
 * @param reading `parseGuardProbeResult` 的产物
 * @returns true 表示需要重载页面
 */
export function needsReload(reading: string | null): boolean {
  if (reading === null) return true;
  const signal = reading.split('|')[0];
  if (signal === 'ds') return false;
  if (signal === 'off') return false;
  return true;
}
