// WebScreen 用得上的两个小工具（#155）：入口路径判定与空状态。
//
// 单独成模块的理由：WebScreen 只该管渲染；这两个判断（"这个地址是不是一次性配对入口"、
// "浮层的初始状态长什么样"）是纯逻辑，放在这里能被 tsc 与未来的测试直接覆盖。
import type { SessionState } from './remote-controller';

/** 空状态（浮层在"端口构建失败"这类场景下需要一个完整状态对象）。 */
export const emptyState: SessionState = {
  phase: 'idle',
  url: null,
  gate: null,
  reason: null,
  version: null,
  entry: null,
  logs: [],
};

/** 配对入口的路径形态（与 `shell-web` 的冻结别名一致：`/pair` 与 `/__dsh-mobile/pair`）。 */
const PAIR_PATHS = ['/pair', '/__dsh-mobile/pair'];

/**
 * 从完整地址里取出「一次性入口路径」（`/pair?token=…`）：
 * - 是配对入口（含冻结别名）→ 返回 `pathname + search`，交给编排去换会话 cookie；
 * - 带 `token` 查询参数的其它地址（dsh 的 `/?token=…`）→ 也算入口；
 * - 普通地址 → null（只做版本检测，不去消费任何一次性凭据）。
 */
export function entryPathOf(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (PAIR_PATHS.includes(path)) return `${path}${u.search}`;
    if (u.searchParams.get('token')) return `${path}${u.search}`;
    return null;
  } catch {
    return null;
  }
}
