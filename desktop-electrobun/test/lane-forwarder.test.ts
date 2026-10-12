import { describe, expect, test } from 'bun:test'
import { startLaneForwarder } from '../src/bun/lane-forwarder.ts'

/** 起一个 echo 目标：收到什么回什么（前缀可区分多个目标）。 */
async function startEcho(prefix: string): Promise<number> {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        socket.write(`${prefix}:${new TextDecoder().decode(chunk)}`)
      },
    },
  })
  return server.port
}

interface Client {
  socket: import('bun').TCPSocket
  /** 等待并取回下一块入站数据。 */
  next(): Promise<string>
  /** 等待连接被对端关闭。 */
  ended: Promise<void>
}

/** 连一个 TCP 客户端；收到的数据按块排队，ended 在 close 时兑现。 */
function connectClient(port: number): Promise<Client> {
  const chunks: string[] = []
  const waiters: Array<(text: string) => void> = []
  let endedResolve: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    endedResolve = resolve
  })
  return new Promise<Client>((resolve, reject) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(_socket, chunk) {
          const text = new TextDecoder().decode(chunk)
          const waiter = waiters.shift()
          if (waiter !== undefined) waiter(text)
          else chunks.push(text)
        },
        close() {
          endedResolve()
        },
        end() {
          endedResolve()
        },
        error(error) {
          reject(error)
        },
      },
    })
      .then((socket) => {
        resolve({
          socket,
          next: async () => {
            const queued = chunks.shift()
            if (queued !== undefined) return queued
            return new Promise<string>((resolveText) => waiters.push(resolveText))
          },
          ended,
        })
      })
      .catch(reject)
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('lane 转发器（旧壳 forwarder.rs 的等价物）', () => {
  test('新连接转发到目标并双向可达（echo 前缀证明落在目标实例）', async () => {
    const targetA = await startEcho('A')
    const forwarder = startLaneForwarder({ port: 0, log: () => {} })
    expect(forwarder).not.toBeNull()
    forwarder?.setTarget(targetA)

    const client = await connectClient(forwarder?.port ?? 0)
    client.socket.write('hello')
    expect(await client.next()).toBe('A:hello')
    client.socket.end()
    forwarder?.stop()
  })

  test('无目标（0）时入站连接直接被关闭', async () => {
    const forwarder = startLaneForwarder({ port: 0, log: () => {} })
    expect(forwarder).not.toBeNull()
    forwarder?.setTarget(0)

    const client = await connectClient(forwarder?.port ?? 0)
    client.socket.write('x')
    await client.ended
    forwarder?.stop()
  })

  test('焦点切换只影响新连接（存量连接保持原目标）', async () => {
    const targetA = await startEcho('A')
    const targetB = await startEcho('B')
    const forwarder = startLaneForwarder({ port: 0, log: () => {} })
    forwarder?.setTarget(targetA)

    const first = await connectClient(forwarder?.port ?? 0)
    first.socket.write('keep')
    expect(await first.next()).toBe('A:keep')

    forwarder?.setTarget(targetB)
    const second = await connectClient(forwarder?.port ?? 0)
    second.socket.write('new')
    expect(await second.next()).toBe('B:new')

    // 存量连接仍落在 A（SSE/WS 不切换的口径）。
    first.socket.write('still')
    expect(await first.next()).toBe('A:still')

    first.socket.end()
    second.socket.end()
    forwarder?.stop()
  })

  test('目标端口连不上时入站被关闭且不崩', async () => {
    const forwarder = startLaneForwarder({ port: 0, log: () => {} })
    forwarder?.setTarget(59999) // 无人监听的端口
    const client = await connectClient(forwarder?.port ?? 0)
    client.socket.write('x')
    await client.ended
    forwarder?.stop()
  })

  test('监听失败返回 null（外部 dsh 占用遗留端口的口径）', () => {
    const blocker = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const logs: string[] = []
    const forwarder = startLaneForwarder({ port: blocker.port, log: (m) => logs.push(m) })
    expect(forwarder).toBeNull()
    expect(logs.some((m) => m.includes('监听失败'))).toBe(true)
    blocker.stop(true)
  })

  test('同目标重复 setTarget 不刷日志', () => {
    const logs: string[] = []
    const forwarder = startLaneForwarder({ port: 0, log: (m) => logs.push(m) })
    forwarder?.setTarget(1234)
    const count = logs.filter((m) => m.includes('lane 目标')).length
    forwarder?.setTarget(1234)
    expect(logs.filter((m) => m.includes('lane 目标')).length).toBe(count)
    forwarder?.stop()
  })
})
