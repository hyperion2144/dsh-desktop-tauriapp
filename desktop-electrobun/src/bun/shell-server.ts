// loopback 服务：页面 origin + 静态资产 + 数据面反代 + WS 隧道。
//
// 为什么是 loopback 而不是自定义协议（ADR 0006）：Electrobun 没有面向应用的自定义
// protocol 注册 API（只有硬编码的 views:// 与 appdata://），而 views:// 在 macOS CEF 下
// `<script src>` 不执行（上游 #237 OPEN）。loopback origin 是真实 origin：secure context、
// localStorage 可写且跨重启存活、SSE/WS 原生可用、cookie 由壳持有——
// 「本地静态 + 数据面同源」对齐官方 Electron 的做法，只是 scheme 名从 dsh-app:// 变成 http://127.0.0.1。
//
// 路由（静态优先，规格第 2 条）：
//   1) 准入判定（token 前缀 / 同源 / 壳自答端点）
//   2) dist 命中就出磁盘文件（本地优先）；index.html 顺带注入 BOOT 行
//   3) 其余一律转发给 Host（/api/*、/plugins/*、插件自带路由、WS 隧道）
//
// 闸门：cookie 由壳持有，转发时剥 set-cookie 与 hop-by-hop 头；/api/* 与 /plugins/* 一律
// no-store。SSE 不再有寿命上限（那与 page_shim 一样是 Tauri 妥协，随迁移删除）。

import { statSync } from 'node:fs'
import { decide } from '../shared/admission.ts'
import { INDEX_FILE, contentTypeFor, isNoContentAsset, resolveAsset } from '../shared/asset-path.ts'
import { corsHeaders, scrubRequestHeaders, scrubResponseHeaders, shouldNoStore } from '../shared/headers.ts'
import { isExternalUrl } from './external.ts'
import type { ContextMenuRequest } from './context-menu.ts'

/** 官方 web-document.ts 的同一行：index 会等异步的 Host 注入，先把 promise 挂上。 */
export const BOOT_LINE = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** Bun 的 WebSocket 客户端支持 headers（DOM 类型里没有），收窄成我们用到的那一面。 */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket

export interface BootPayload {
  injections: unknown[]
  streamBaseUrl: string
}

export interface ShellServerOptions {
  distDir: string
  token: string
  cookie: string
  /** 上游（Host）origin，如 http://127.0.0.1:55600 */
  upstreamOrigin: string
  port: number
  /** 宿主就绪前返回 null（页面会等 __DSH_BOOT_READY__） */
  bootPayload: () => BootPayload | null
  /** 「在系统浏览器打开」——由主进程实现（Electrobun Utils.openExternal）。 */
  onOpenExternal?: (url: string) => void
  /** 页面右键菜单——由主进程弹原生菜单。 */
  onContextMenu?: (request: ContextMenuRequest) => void
  /** 单实例激活：第二个壳请求把窗口带到前台（主进程实现） */
  onActivate?: () => void
  onLog?: (line: string) => void
}

export interface ShellServer {
  origin: string
  port: number
  stop: () => void
  /** 缝 ① 用的进程内自检视图 */
  health: () => Record<string, unknown>
}

interface WsData {
  upstream?: WebSocket
  queue?: (string | ArrayBufferLike)[]
  path: string
}

export function startShellServer(options: ShellServerOptions): ShellServer {
  const log = options.onLog ?? (() => {})
  const startedAt = Date.now()
  const origin = `http://127.0.0.1:${String(options.port)}`
  const authority = new URL(options.upstreamOrigin).host
  let served = 0
  let proxied = 0

  async function serveStatic(rel: string): Promise<Response | null> {
    const file = resolveAsset(options.distDir, rel)
    // 源映射：按现状协议不变量直接 204（不看文件是否存在，也不泄露存在性）
    if (isNoContentAsset(rel)) return new Response(null, { status: 204 })
    if (file === null) return null
    let stat
    try {
      stat = statSync(file)
    } catch {
      return null
    }
    if (stat.isDirectory()) return serveStatic(`${rel.replace(/\/$/, '')}/${INDEX_FILE}`)
    if (!stat.isFile()) return null

    if (rel.endsWith('.html') || rel.endsWith(`/${INDEX_FILE}`)) {
      const raw = await Bun.file(file).text()
      return new Response(injectBoot(raw), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }
    return new Response(Bun.file(file), {
      status: 200,
      headers: { 'content-type': contentTypeFor(file), 'cache-control': 'no-store' },
    })
  }

  function injectBoot(html: string): string {
    const head = html.indexOf('<head>')
    if (head < 0) return `${BOOT_LINE}\n${html}`
    const insertAt = head + '<head>'.length
    return `${html.slice(0, insertAt)}${BOOT_LINE}${html.slice(insertAt)}`
  }

  async function proxy(request: Request, pathname: string, search: string): Promise<Response> {
    proxied += 1
    const target = `${options.upstreamOrigin}${pathname}${search}`
    const headers = scrubRequestHeaders(request.headers, { cookie: options.cookie, authority })
    const method = request.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD'
    let upstream: Response
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
      })
    } catch (error) {
      log(`[shell] 转发失败 ${method} ${pathname}: ${String(error)}`)
      return new Response('upstream unreachable', { status: 502 })
    }
    const outHeaders = scrubResponseHeaders(upstream.headers, { pathname })
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
  }

  const server = Bun.serve<WsData, string>({
    hostname: '127.0.0.1',
    port: options.port,
    async fetch(request, srv) {
      const url = new URL(request.url)
      const decision = decide({
        pathname: url.pathname,
        token: options.token,
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        selfOrigin: origin,
      })

      if (decision.kind === 'reject') {
        log(`[shell] 拒绝跨站请求 ${url.pathname}（origin=${request.headers.get('origin') ?? '-'}）`)
        return new Response('forbidden', { status: decision.status ?? 403 })
      }

      if (request.method.toUpperCase() === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) })
      }

      if (decision.kind === 'shell') {
        if (decision.rel === 'health') {
          return Response.json(health())
        }
        if (decision.rel === 'boot') {
          const payload = options.bootPayload()
          if (payload === null) return new Response('boot pending', { status: 503 })
          return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
        }
        // 外链：交给系统浏览器（页面里 window.open / 点击 / 中键都走这里）
        if (decision.rel === 'open-external') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onOpenExternal === undefined) return new Response('no window host', { status: 501 })
          const body = (await request.json().catch(() => null)) as { url?: unknown } | null
          const target = typeof body?.url === 'string' ? body.url : ''
          if (target === '' || !isExternalUrl(target, origin)) {
            log(`[shell] 拒绝外链 ${target}`)
            return new Response('not an external url', { status: 400 })
          }
          options.onOpenExternal(target)
          log(`[shell] 外链转系统浏览器 ${target}`)
          return new Response(null, { status: 204 })
        }
        // 右键菜单：页面把上下文报过来，主进程弹原生菜单
        if (decision.rel === 'context-menu') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onContextMenu === undefined) return new Response('no window host', { status: 501 })
          const body = (await request.json().catch(() => null)) as Partial<ContextMenuRequest> | null
          options.onContextMenu({
            linkUrl: typeof body?.linkUrl === 'string' && body.linkUrl !== '' ? body.linkUrl : null,
            hasSelection: body?.hasSelection === true,
            editable: body?.editable === true,
          })
          return new Response(null, { status: 204 })
        }
        // 单实例：第二个壳请已有实例把窗口带到前台（不占端口、不起宿主）
        if (decision.rel === 'activate') {
          if (request.method.toUpperCase() !== 'POST') return new Response('method not allowed', { status: 405 })
          if (options.onActivate === undefined) return new Response('no window host', { status: 501 })
          options.onActivate()
          log('[shell] 收到激活请求：窗口带到前台')
          return new Response(null, { status: 204 })
        }
        return new Response('not found', { status: 404 })
      }

      // WS 隧道：升级本地连接，再开一条到上游的双向管道
      if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
        const upgraded = srv.upgrade(request, { data: { path: `${decision.stripped}${url.search}` } })
        if (upgraded) return undefined as unknown as Response
        return new Response('upgrade failed', { status: 400 })
      }

      // 静态只服务文档类（带 token）——根绝对路径不打 token，不能从 dist 出东西
      const staticHit = decision.kind === 'document' ? await serveStatic(decision.rel) : null
      if (staticHit !== null) {
        served += 1
        return staticHit
      }
      if (isNoContentAsset(url.pathname)) return new Response(null, { status: 204 })
      // 文档类未命中本地 dist：按剥掉 token 的路径转发（插件客户端脚本就走 token 前缀下）
      return proxy(request, decision.stripped, url.search)
    },
    websocket: {
      open(ws) {
        const data = ws.data
        const target = `ws://${authority}${data.path}`
        const upstream = new BunWebSocket(target, { headers: { cookie: options.cookie } })
        data.upstream = upstream
        upstream.addEventListener('open', () => {
          for (const item of data.queue ?? []) upstream.send(item)
          data.queue = []
        })
        upstream.addEventListener('message', (event) => {
          const payload = event.data
          if (typeof payload === 'string') ws.send(payload)
          else if (payload instanceof ArrayBuffer) ws.send(payload)
          else ws.send(String(payload))
        })
        upstream.addEventListener('close', () => ws.close())
        upstream.addEventListener('error', () => ws.close())
      },
      message(ws, message) {
        const upstream = ws.data.upstream
        if (upstream === undefined || upstream.readyState !== WebSocket.OPEN) {
          ws.data.queue = [...(ws.data.queue ?? []), message as string | ArrayBufferLike]
          return
        }
        upstream.send(message as string | ArrayBufferLike)
      },
      close(ws) {
        try {
          ws.data.upstream?.close()
        } catch {}
      },
    },
  })

  function health(): Record<string, unknown> {
    const boot = options.bootPayload()
    return {
      ok: true,
      pid: process.pid,
      origin,
      upstream: options.upstreamOrigin,
      token: options.token,
      injections: boot?.injections.length ?? 0,
      bootReady: boot !== null,
      served,
      proxied,
      uptimeMs: Date.now() - startedAt,
    }
  }

  log(`[shell] loopback origin = ${origin} | 页面 = ${origin}/${options.token}/ | 上游 = ${options.upstreamOrigin}`)

  return {
    origin,
    port: options.port,
    health,
    stop: () => {
      void server.stop(true)
    },
  }
}

export { shouldNoStore }
