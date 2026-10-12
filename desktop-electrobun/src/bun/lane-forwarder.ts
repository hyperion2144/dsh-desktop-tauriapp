/**
 * lane TCP 转发器（手机稳定接入点，旧壳 `desktop/src-tauri/src/network/forwarder.rs` #94 的等价物）。
 *
 * 各实例的 lane 端口整体错开（3092 起），壳在「遗留手机配置端口」（settings 的 lanePort，
 * 默认 3091）监听并把 TCP 原样转发到**焦点窗口实例**的 lane——手机旧配置零改动，新连接
 * 始终落焦点实例；存量长连接不切换（SSE/WS 保持原实例，新请求落新目标）。
 *
 * 行为对齐旧壳：
 * · 监听失败（最常见：外部 dsh 自己的 lane 占了 3091）→ 警告后退场，不做转发跟随。
 * · 无目标（焦点实例还没起来 / 全部窗口关闭）→ 入站连接直接关闭。
 * · 焦点切换只影响**新**连接。
 */
import type { TCPSocket } from 'bun'

export interface LaneForwarder {
  /** 监听实际落在的端口（构造传入 0 时由系统分配）。 */
  readonly port: number
  /** 焦点实例变化时更新目标（0 = 无目标，新连接直接关闭）。 */
  setTarget(port: number): void
  /** 停止监听并断开现存连接。 */
  stop(): void
}

export interface LaneForwarderOptions {
  /** 监听端口（遗留手机配置端口，settings 的 lanePort）。 */
  port: number
  /** 监听地址，缺省 127.0.0.1。 */
  hostname?: string
  log?: (message: string) => void
}

interface Pair {
  outbound: TCPSocket | null
  pending: Uint8Array[]
  closed: boolean
}

export function startLaneForwarder(options: LaneForwarderOptions): LaneForwarder | null {
  const hostname = options.hostname ?? '127.0.0.1'
  const log = options.log ?? (() => {})
  let currentTarget = 0
  const pairs = new WeakMap<TCPSocket, Pair>()

  function teardown(socket: TCPSocket): void {
    const pair = pairs.get(socket)
    if (pair !== undefined) {
      pair.closed = true
      pair.outbound?.end()
      pairs.delete(socket)
    }
  }

  async function connectOutbound(socket: TCPSocket, pair: Pair, target: number): Promise<void> {
    try {
      const outbound = await Bun.connect({
        hostname: '127.0.0.1',
        port: target,
        socket: {
          data(_outbound, chunk) {
            if (!pair.closed) socket.write(chunk)
          },
          error(_outbound) {
            socket.end()
          },
          close() {
            socket.end()
          },
        },
      })
      if (pair.closed) {
        outbound.end()
        return
      }
      pair.outbound = outbound
      for (const chunk of pair.pending) outbound.write(chunk)
      pair.pending.length = 0
    } catch (error) {
      log(`[forwarder] 连接目标 ${String(target)} 失败：${error instanceof Error ? error.message : String(error)}`)
      socket.end()
    }
  }

  let server
  try {
    server = Bun.listen({
      hostname,
      port: options.port,
      socket: {
        open(socket) {
          const pair: Pair = { outbound: null, pending: [], closed: false }
          pairs.set(socket, pair)
          if (currentTarget === 0) {
            pair.closed = true
            socket.end()
            return
          }
          void connectOutbound(socket, pair, currentTarget)
        },
        data(socket, chunk) {
          const pair = pairs.get(socket)
          if (pair === undefined || pair.closed) return
          if (pair.outbound !== null) pair.outbound.write(chunk)
          else pair.pending.push(chunk)
        },
        error(socket) {
          teardown(socket)
        },
        close(socket) {
          teardown(socket)
        },
      },
    })
  } catch (error) {
    // 常见原因：外部 dsh 自身 lane 占了遗留端口——此时手机直连它即可，转发器退场。
    log(`[forwarder] 端口 ${String(options.port)} 监听失败（${error instanceof Error ? error.message : String(error)}），lane 焦点跟随不可用`)
    return null
  }

  log(`[forwarder] 手机稳定接入点 ${hostname}:${String(server.port)}（跟随焦点窗口）`)

  return {
    port: server.port,
    setTarget(port) {
      if (port === currentTarget) return
      currentTarget = port
      log(`[forwarder] lane 目标 → ${String(port)}`)
    },
    stop() {
      currentTarget = 0
      server.stop(true)
    },
  }
}
