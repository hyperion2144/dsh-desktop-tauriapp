// 壳的通知/忙状态入口（旧壳 `desktop/src-tauri/src/network/notify.rs` 的等价物）。
//
// 谁在用：dsh 侧的桌面壳插件（仓库根 `index.js`）——它在宿主里订阅 `session/event`，
// 把两件事 POST 到 `http://127.0.0.1:<port>/notify`（端口与令牌由壳 spawn 时注入环境变量）：
//   · `{ type: 'busy-state', profile, busy }`：跑着的会话 → 防休眠断言（本模块只做分发）
//   · `{ type: 'task-complete' | 'dsh-approval', body }`：通知（通知轮次接）
// 现状壳把它跑在**独立**的随机端口上（与页面/数据面分开），这里同构：token 每启动随机，
// 只绑 127.0.0.1；令牌不符 401，方法不符 405，坏 JSON 400——插件侧对失败是静默的（不是关键路径）。
//
// 防御纪律：载荷体积上限 64 KiB（与协议层同量级），不做任何转发，不读磁盘。

import { randomBytes } from 'node:crypto'
import { parseBusyReport, UNKNOWN_PROFILE } from '../shared/power-arbiter.ts'

/** 载荷上限：通知文本远小于此，超了直接 413。 */
export const MAX_NOTIFY_BYTES = 64 * 1024

/** 通知类载荷的类型（通知轮次消费；本模块只把它们交给回调）。 */
export const NOTIFY_TYPES = ['task-complete', 'dsh-approval', 'dsh-error'] as const

export type NotifyType = (typeof NOTIFY_TYPES)[number]

export interface NotifyPayload {
  type: NotifyType
  body: string
}

export interface NotifyServerOptions {
  /** 忙状态上报（已过类型校验）。 */
  onBusy?: (profile: string, busy: boolean) => void
  /** 通知类上报（通知轮次接；不接就只留日志）。 */
  onNotify?: (payload: NotifyPayload) => void
  /** 缺省每启动随机（与旧壳 `random_token()` 同义）。 */
  token?: string
  /** 缺省 0（随机端口）。 */
  port?: number
  hostname?: string
  onLog?: (line: string) => void
}

export interface NotifyServer {
  port: number
  token: string
  /** `http://127.0.0.1:<port>`（注入给 dsh 子进程的形态）。 */
  origin: string
  stop: () => void
}

/** 随机令牌（base64url，与旧壳 32 字节随机同量级）。 */
export function randomNotifyToken(): string {
  return randomBytes(24).toString('base64url')
}

/** 解析并分类 `/notify` 载荷：忙状态 / 通知 / 都不认。 */
export function classifyNotify(
  payload: unknown,
): { kind: 'busy'; profile: string; busy: boolean } | { kind: 'notify'; payload: NotifyPayload } | { kind: 'unknown' } {
  const busy = parseBusyReport(payload)
  if (busy !== null) return { kind: 'busy', profile: busy.profile, busy: busy.busy }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'unknown' }
  const record = payload as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string' || !(NOTIFY_TYPES as readonly string[]).includes(type)) return { kind: 'unknown' }
  const body = typeof record.body === 'string' ? record.body : ''
  return { kind: 'notify', payload: { type: type as NotifyType, body } }
}

/** 严格取 `Authorization: Bearer <token>`；大小写与多余空格都容忍（旧壳同义）。 */
export function bearerToken(header: string | null): string {
  if (header === null) return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? ''
}

export function startNotifyServer(options: NotifyServerOptions = {}): NotifyServer {
  const token = options.token ?? randomNotifyToken()
  const log = options.onLog ?? ((): void => {})
  const hostname = options.hostname ?? '127.0.0.1'

  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname !== '/notify') return new Response('not found', { status: 404 })
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
      }
      if (bearerToken(request.headers.get('authorization')) !== token) {
        log('[notify] 令牌不符，已拒绝')
        return new Response('unauthorized', { status: 401 })
      }
      const length = Number(request.headers.get('content-length') ?? '0')
      if (Number.isFinite(length) && length > MAX_NOTIFY_BYTES) {
        return new Response('payload too large', { status: 413 })
      }
      const text = await request.text()
      if (text.length > MAX_NOTIFY_BYTES) return new Response('payload too large', { status: 413 })
      let payload: unknown
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        return new Response('bad json', { status: 400 })
      }
      const classified = classifyNotify(payload)
      if (classified.kind === 'busy') {
        options.onBusy?.(classified.profile === '' ? UNKNOWN_PROFILE : classified.profile, classified.busy)
      } else if (classified.kind === 'notify') {
        options.onNotify?.(classified.payload)
      } else {
        log('[notify] 忽略未知载荷')
      }
      return new Response(null, { status: 204 })
    },
  })

  const port = server.port ?? 0
  log(`通知口已就绪：${hostname}:${String(port)}`)
  return {
    port,
    token,
    origin: `http://${hostname}:${String(port)}`,
    stop: (): void => {
      server.stop(true)
    },
  }
}
