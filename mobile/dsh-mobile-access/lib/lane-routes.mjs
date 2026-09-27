//! lane 自有路由的保留命名空间与匹配器（#145）。
//!
//! 反代的本职是「把发往 dsh 端口的请求原样透传」。lane 自己的控制面（配对、设备、
//! 隧道、事件）因此必须住在**保留命名空间**里、永不与 dsh 路由同形——否则上游一次
//! 新增路由就可能被 lane 截胡，而这类截胡在远程端只表现为「某个设置/接口拿不到」，
//! 极难排查（#145 的根因之一）。
//!
//! 命名空间下的规范路径 = `LANE_PREFIX` + 相对路径（`LANE_ROUTE_PATHS`）。
//!
//! 历史兼容：命名空间上线前这些端点直接挂在 `/pair` 与 `/api/pair/*`。已发出的配对
//! 链接（二维码、设备上的 `remote_list` 存档）与尚未升级的设备仍会打这些路径，故保留
//! 为**冻结别名**（`LANE_LEGACY_PATHS`）：只读快照，**新增路由不得加入此表**——新能力
//! 一律走命名空间，别名集合只会随时间收缩、不再增长。

/** lane 控制面的保留命名空间前缀。dsh 自身不拥有任何 `/__dsh-mobile*` 路径。 */
export const LANE_PREFIX = '/__dsh-mobile';

/** 把 lane 相对路径升格为保留命名空间下的规范路径。 */
export function lanePath(relative) {
  return LANE_PREFIX + relative;
}

/**
 * lane 自有路由（相对路径）。任何新增控制端点都必须登记在这里——它同时是
 * 「lane 会截胡哪些路径」的唯一事实源，测试据此锁死透传不变式。
 */
export const LANE_ROUTE_PATHS = Object.freeze([
  '/pair',
  '/api/pair/info',
  '/api/pair/accept',
  '/api/pair/mint',
  '/api/pair/probe',
  '/api/pair/tunnel',
  '/api/pair/devices',
  '/api/pair/remove',
  '/api/pair/stop',
  '/api/pair/events',
  '/api/pair/cloudflared',
]);

/**
 * 冻结的兼容别名（无前缀的历史路径，与 `LANE_ROUTE_PATHS` 一一对应）。
 * 仅为已发出的配对链接与旧客户端存活，**不得新增**。
 */
export const LANE_LEGACY_PATHS = Object.freeze([...LANE_ROUTE_PATHS]);

/**
 * 判定一次请求是否属于 lane 控制面，并返回其**相对路径**（调方一律按相对路径分派）。
 *
 * 返回 null 表示「不归 lane 管」：调用方必须让请求继续走反代透传——包括 OPTIONS
 * 预检与 dsh 自有路径，lane 绝不代答（这正是「所有 dsh 端口请求全量透传」的落点）。
 *
 * @param {string} path 请求路径（已去掉查询串）
 * @returns {string|null} lane 相对路径；不属于 lane 时为 null
 */
export function laneRoutePath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  // 容忍末尾斜杠：ArkWeb/WebView 与旧壳的解析器会把入口规范成目录形式。
  // 实机踩过：`/__dsh-mobile/pair/` 不命中路由 → 落到反代门禁 → 401 UNPAIRED
  // （手机上扫完码却显示未配对）。
  const p = path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path;
  if (p.startsWith(LANE_PREFIX + '/')) {
    const relative = p.slice(LANE_PREFIX.length);
    return LANE_ROUTE_PATHS.includes(relative) ? relative : null;
  }
  // 命名空间本身（无尾斜杠）：只认配对入口，其余按未命中透传。
  if (p === LANE_PREFIX + '/pair') return '/pair';
  return LANE_LEGACY_PATHS.includes(p) ? p : null;
}

/** 是否为保留命名空间下的路径（含命名空间根；用于诊断与测试断言）。 */
export function isReservedLanePath(path) {
  return typeof path === 'string' && (path === LANE_PREFIX || path.startsWith(LANE_PREFIX + '/'));
}
