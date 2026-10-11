// 壳 ↔ 页面 的 RPC（旧壳 Tauri IPC 的等价物，规格决策 12「IPC 接线放弃改每视图 RPC」）。
//
// 为什么要有这一层：壳自己的客户端插件（`src/client/*`：设置面板、通知 tab、下载 tab、
// 本地 chrome、平台键盘…）全部经 `__TAURI_INTERNALS__.invoke(cmd, args)` 与壳通信。
// 新壳里没有 Tauri，插件于是在第一步 `get_desktop_client_environment` 就拿到 undefined
// 并整片不激活——设置面板在实机上「消失」就是这么来的。
//
// 本层是**纯逻辑**：请求解析、路由、错误语义都在这里，HTTP 细节留给 shell-server。
// 契约（与 Tauri 的 invoke 对齐）：
//   · 成功 → `{ ok: true, value }`，页面侧 shim 把 value 直接 resolve；
//   · 业务失败 → `{ ok: false, error }`，页面侧 reject(new Error(error))；
//   · 请求本身不合法（坏 JSON / 缺 cmd）→ 400，未知命令 → `ok:false` + 明确文案
//     （面板会把它显示成「无 Tauri IPC / 命令不支持」，而不是永远转圈）。

/** 请求体上限：设置 patch 与快捷键文件都远小于它；超过就是有人在乱灌。 */
export const MAX_RPC_BYTES = 1024 * 1024

export interface RpcRequest {
  cmd: string
  args: Record<string, unknown>
}

/**
 * 调用方身份（每视图授权台账里的那一行）。
 *
 * 命令表里绝大多数命令不关心「是谁在调」，但 guest 那几条必须知道：guest 要挂在**发起调用的那个窗口**上，
 * 关闭窗口/退出时也要按窗口批量回收。`grant` 为 null ＝ 该路径没开每视图校验（测试与旧调用点）。
 */
export interface RpcCaller {
  kind: 'shell' | 'guest'
  profile: string
  label: string
}

export interface RpcContext {
  caller?: RpcCaller
}

export type RpcHandler = (args: Record<string, unknown>, context?: RpcContext) => unknown | Promise<unknown>

export type RpcRouter = Map<string, RpcHandler>

export interface RpcResult {
  status: number
  body: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析请求体；不合法返回 null（调用方回 400）。 */
export function parseRpcRequest(raw: string): RpcRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const cmd = parsed.cmd
  if (typeof cmd !== 'string' || cmd === '') return null
  const args = parsed.args
  if (args !== undefined && !isRecord(args)) return null
  return { cmd, args: isRecord(args) ? args : {} }
}

export function createRpcRouter(handlers: Record<string, RpcHandler>): RpcRouter {
  const router: RpcRouter = new Map()
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue
    router.set(name, handler)
  }
  return router
}

/** 命令表里有哪些命令（诊断/测试用；排序保证输出稳定）。 */
export function rpcCommands(router: RpcRouter): string[] {
  return [...router.keys()].sort()
}

/**
 * 派发一次调用。**永不抛**：任何异常都变成 `ok:false`，让页面侧拿到可读原因
 * （Tauri 的 invoke 也是 reject 语义，插件里到处是 `.catch(...)`）。
 */
export async function dispatchRpc(router: RpcRouter, raw: string, context: RpcContext = {}): Promise<RpcResult> {
  if (raw.length > MAX_RPC_BYTES) {
    return { status: 413, body: { ok: false, error: 'rpc payload too large' } }
  }
  const request = parseRpcRequest(raw)
  if (request === null) {
    return { status: 400, body: { ok: false, error: 'malformed rpc request' } }
  }
  const handler = router.get(request.cmd)
  if (handler === undefined) {
    return { status: 200, body: { ok: false, error: `unsupported command: ${request.cmd}` } }
  }
  try {
    const value = await handler(request.args, context)
    return { status: 200, body: { ok: true, value: value ?? null } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 200, body: { ok: false, error: message } }
  }
}

/** 取参数里的字符串（缺省给默认值；给错类型按「没给」处理，命令自己决定要不要报错）。 */
export function argString(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value : fallback
}

export function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** patch 形状校验：设置面板传 `{ patch: {...} }`；非对象一律拒（不能把整份设置覆盖成垃圾）。 */
export function argPatch(args: Record<string, unknown>): Record<string, unknown> {
  const value = args.patch
  if (!isRecord(value)) throw new Error('save_desktop_settings: patch 必须是对象')
  return value
}
