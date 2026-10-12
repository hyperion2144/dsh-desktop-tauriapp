// 下载管理器测试（旧壳 `download/{model,persist,manager,transfer}.rs` 的等价物）。
//
// 两条缝：
//   · 纯策略（`src/shared/downloads.ts`）：命名、.part 路径、恢复语义、裁剪、进度
//   · 管理器（`src/bun/downloads.ts`）：真文件系统（临时目录）+ 注入 fetch 桩，
//     覆盖 URL 直链（含 206 续传、416 回退全量）、并发闸门、暂停/恢复/取消、
//     blob 分块管线、任务表落盘与跨重启恢复、清空已完成、并发上限夹取

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  filenameFromUrl,
  isTerminal,
  MAX_TASKS,
  partPath,
  progressPercent,
  pruneTasks,
  recoverTasks,
  sanitizeFilename,
  sortTasks,
  uniqueTargetPath,
  type DownloadTask,
} from '../src/shared/downloads.ts'
import { createDownloadManager, downloadsDir, tasksFileOf } from '../src/bun/downloads.ts'

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function taskOf(patch: Partial<DownloadTask>): DownloadTask {
  return {
    id: 1,
    kind: 'url',
    url: 'http://127.0.0.1:3080/api/session.export',
    filename: 'session.export',
    targetPath: '/tmp/dl/session.export',
    total: null,
    received: 0,
    etag: null,
    resumed: false,
    status: 'queued',
    error: null,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  }
}

/** 等条件成立（管理器里的传输是后台跑的）。 */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error('等待超时')
}

describe('下载：纯策略（旧壳 download/model.rs + persist.rs）', () => {
  test('文件名清洗：路径分隔符/控制字符换成下划线、去首尾点、空则 download', () => {
    expect(sanitizeFilename('a/b\\c:d')).toBe('a_b_c_d')
    expect(sanitizeFilename('  ..报告..zip.. ')).toBe('报告..zip')
    expect(sanitizeFilename('')).toBe('download')
    expect(sanitizeFilename('\u0007x')).toBe('_x')
    expect(sanitizeFilename('x'.repeat(200)).length).toBe(120)
  })

  test('从 URL 尾段取默认文件名（去查询串、解 %XX）', () => {
    expect(filenameFromUrl('http://h/api/session.export?sessionId=s1')).toBe('session.export')
    expect(filenameFromUrl('http://h/a/%E6%8A%A5%E5%91%8A.zip')).toBe('报告.zip')
    expect(filenameFromUrl('http://h/')).toBe('download')
  })

  test('.part 与目标同目录同名', () => {
    const task = taskOf({ targetPath: '/tmp/dl/f7.zip', filename: 'f7.zip' })
    expect(partPath(task)).toBe('/tmp/dl/f7.zip.part')
  })

  test('目标名撞车（或它的 .part 已存在）时退成 `名字 (1).ext`', () => {
    const taken = new Set(['/d/report.zip.part'])
    expect(uniqueTargetPath('/d', 'report.zip', (p) => taken.has(p))).toBe('/d/report (1).zip')
    expect(uniqueTargetPath('/d', 'report.zip', () => false)).toBe('/d/report.zip')
    expect(uniqueTargetPath('/d', 'README', (p) => p === '/d/README')).toBe('/d/README (1)')
  })

  test('恢复语义：URL 非终态转 paused（.part 留着续传）', () => {
    const result = recoverTasks([taskOf({ status: 'downloading', received: 5 })], 200)
    expect(result.tasks[0]?.status).toBe('paused')
    expect(result.tasks[0]?.received).toBe(5)
    expect(result.changed).toBe(true)
    expect(result.dropped).toEqual([])
  })

  test('恢复语义：blob 非终态作废成 cancelled 并要清 .part', () => {
    const result = recoverTasks([taskOf({ kind: 'blob', status: 'downloading' })], 200)
    expect(result.tasks[0]?.status).toBe('cancelled')
    expect(result.tasks[0]?.error).toContain('blob')
    expect(result.dropped.length).toBe(1)
  })

  test('恢复语义：终态原样保留、坏行丢弃', () => {
    const result = recoverTasks(
      [taskOf({ id: 1, status: 'completed' }), { id: 'x' }, null, taskOf({ id: 3, status: 'cancelled' })],
      200
    )
    expect(result.tasks.map((task) => task.id)).toEqual([1, 3])
    expect(result.changed).toBe(true)
  })

  test('裁剪：超限先淘汰最老的终态任务，非终态永不裁剪', () => {
    const tasks = Array.from({ length: MAX_TASKS + 1 }, (_, index) =>
      taskOf({ id: index, status: 'completed', updatedAt: index })
    )
    tasks[0] = taskOf({ id: 0, status: 'paused', updatedAt: 0 })
    const pruned = pruneTasks(tasks)
    expect(pruned.tasks.length).toBe(MAX_TASKS)
    expect(pruned.tasks.some((task) => task.id === 0)).toBe(true)
    expect(pruned.dropped.map((task) => task.id)).toEqual([1])
  })

  test('进度百分比与终态判定', () => {
    expect(progressPercent({ received: 50, total: 200 })).toBe(25)
    expect(progressPercent({ received: 5, total: null })).toBeNull()
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('paused')).toBe(false)
  })

  test('列表新任务在前', () => {
    expect(sortTasks([taskOf({ id: 1 }), taskOf({ id: 3 }), taskOf({ id: 2 })]).map((t) => t.id)).toEqual([3, 2, 1])
  })
})

describe('下载：管理器（真文件系统 + fetch 桩）', () => {
  test('URL 直链：排队 → 下载中 → 完成，.part 被改名，通知发出', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    const notified: string[] = []
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      notify: (name) => notified.push(name),
      chooseDirectory: async () => dir,
      fetchImpl: async () => new Response('hello world', { status: 200, headers: { 'content-length': '11' } }),
    })
    const id = await manager.startUrl('http://127.0.0.1:3080/api/session.export', 'session.export')
    await waitFor(() => manager.list()[0]?.status === 'completed')
    const task = manager.list()[0]
    expect(task?.id).toBe(id)
    expect(task?.total).toBe(11)
    expect(task?.received).toBe(11)
    expect(readFileSync(join(dir, 'session.export'), 'utf8')).toBe('hello world')
    expect(existsSync(join(dir, 'session.export.part'))).toBe(false)
    expect(notified).toEqual(['session.export'])
    // 落盘的任务表也要是完成态
    const saved = JSON.parse(readFileSync(tasksFileOf(home), 'utf8')) as DownloadTask[]
    expect(saved[0]?.status).toBe('completed')
  })

  // 实机探针抓到的：目标目录可能还不存在（用户填的路径 / 拆走的 Downloads）
  test('目标目录不存在时自己建出来，而不是 ENOENT 失败', async () => {
    const home = tempDir('dsh-dl-home-')
    const base = tempDir('dsh-dl-target-')
    const nested = join(base, 'not', 'yet', 'Downloads')
    const manager = createDownloadManager({
      home,
      downloadDir: nested,
      log: () => {},
      chooseDirectory: async () => nested,
      fetchImpl: async () => new Response('made it', { status: 200, headers: { 'content-length': '7' } }),
    })
    await manager.startUrl('http://127.0.0.1:3080/api/session.export', 'session.export')
    await waitFor(() => manager.list()[0]?.status === 'completed')
    expect(readFileSync(join(nested, 'session.export'), 'utf8')).toBe('made it')
  })

  test('URL 直链：服务器 206 + 已有 .part ⇒ 续传（received 累加，最终内容拼接）', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    // 续传的前提：上一轮留下的任务（paused）与它的 .part 都还在
    mkdirSync(downloadsDir(home), { recursive: true })
    writeFileSync(
      tasksFileOf(home),
      JSON.stringify([
        taskOf({ id: 1, filename: 'big.bin', targetPath: join(dir, 'big.bin'), received: 6, status: 'paused' }),
      ])
    )
    writeFileSync(join(dir, 'big.bin.part'), 'hello ')
    const seen: Array<{ range: string | null; ifRange: string | null }> = []
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers)
        seen.push({ range: headers.get('range'), ifRange: headers.get('if-range') })
        return new Response('world', { status: 206, headers: { 'content-length': '5', etag: 'W/"1"' } })
      },
    })
    manager.resume(1)
    await waitFor(() => manager.list()[0]?.status === 'completed')
    expect(seen[0]?.range).toBe('bytes=6-')
    expect(readFileSync(join(dir, 'big.bin'), 'utf8')).toBe('hello world')
    expect(manager.list()[0]?.received).toBe(11)
    expect(manager.list()[0]?.total).toBe(11)
  })

  test('URL 直链：服务器 416 ⇒ 丢掉续传全量重下（resumed 复位、内容被覆盖）', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    // 断点所在的那棵树已经不认了（服务器不认 Range 或文件变了）⇒ 必须回退全量重下
    mkdirSync(downloadsDir(home), { recursive: true })
    writeFileSync(
      tasksFileOf(home),
      JSON.stringify([
        taskOf({ id: 1, filename: 'x.bin', targetPath: join(dir, 'x.bin'), received: 13, status: 'paused' }),
      ])
    )
    writeFileSync(join(dir, 'x.bin.part'), 'stale-partial')
    let calls = 0
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response('', { status: 416 })
        return new Response('fresh', { status: 200, headers: { 'content-length': '5' } })
      },
    })
    manager.resume(1)
    await waitFor(() => manager.list()[0]?.status === 'completed')
    expect(calls).toBe(2)
    expect(readFileSync(join(dir, 'x.bin'), 'utf8')).toBe('fresh')
    expect(manager.list()[0]?.resumed).toBe(false)
  })

  test('URL 直链：HTTP 错误 ⇒ failed 且带原因，.part 留着', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async () => new Response('nope', { status: 404 }),
    })
    await manager.startUrl('http://127.0.0.1:3080/api/missing', 'missing')
    await waitFor(() => manager.list()[0]?.status === 'failed')
    expect(manager.list()[0]?.error).toContain('404')
  })

  test('用户取消目录选择 ⇒ 任务标 cancelled，不发请求', async () => {
    const home = tempDir('dsh-dl-home-')
    let calls = 0
    const manager = createDownloadManager({
      home,
      downloadDir: tempDir('dsh-dl-target-'),
      log: () => {},
      chooseDirectory: async () => null,
      fetchImpl: async () => {
        calls += 1
        return new Response('x', { status: 200 })
      },
    })
    await manager.startUrl('http://h/a.zip', 'a.zip')
    expect(manager.list()[0]?.status).toBe('cancelled')
    expect(calls).toBe(0)
  })

  test('并发闸门：上限 1 时同一时刻只有一个任务在跑', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    let active = 0
    let peak = 0
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      concurrency: 1,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async () => {
        active += 1
        peak = Math.max(peak, active)
        await Bun.sleep(20)
        active -= 1
        return new Response('ok', { status: 200 })
      },
    })
    await manager.startUrl('http://h/1.bin', '1.bin')
    await manager.startUrl('http://h/2.bin', '2.bin')
    await manager.startUrl('http://h/3.bin', '3.bin')
    await waitFor(() => manager.list().every((task) => task.status === 'completed'), 3_000)
    expect(peak).toBe(1)
  })

  test('暂停 / 恢复 / 取消：状态机与 .part 清理', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    // 闸门：让 fetch 桩的第一段先落地、剩下的等测试放开（用对象包住避开闭包赋值收窄）
    const gateBox: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((resolve) => {
      gateBox.release = resolve
    })
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async () => {
        // 先落一段再等闸门：暂停时 .part 已有内容
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial-'))
            void gate.then(() => {
              controller.close()
            })
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-length': '100' } })
      },
    })
    const id = await manager.startUrl('http://h/slow.bin', 'slow.bin')
    await waitFor(() => (manager.list()[0]?.received ?? 0) > 0)
    manager.pause(id)
    expect(manager.list()[0]?.status).toBe('paused')
    expect(existsSync(join(dir, 'slow.bin.part'))).toBe(true)
    // 恢复：回到排队（fetch 桩会再被调一次）
    manager.resume(id)
    expect(['queued', 'downloading']).toContain(manager.list()[0]?.status ?? '')
    manager.cancel(id)
    expect(manager.list()[0]?.status).toBe('cancelled')
    expect(existsSync(join(dir, 'slow.bin.part'))).toBe(false)
    gateBox.release()
  })

  test('blob 分块管线：写入 → 完成改名；暂停后拒收分块', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async () => new Response('', { status: 200 }),
    })
    const id = await manager.startBlob('blob.bin', 6)
    expect(manager.list()[0]?.status).toBe('downloading')
    expect(manager.saveChunk(id, Buffer.from('abc').toString('base64'))).toBe(true)
    expect(manager.saveChunk(id, Buffer.from('def').toString('base64'))).toBe(true)
    expect(manager.list()[0]?.received).toBe(6)
    expect(manager.finishBlob(id)).toBe(true)
    expect(manager.list()[0]?.status).toBe('completed')
    expect(readFileSync(join(dir, 'blob.bin'), 'utf8')).toBe('abcdef')

    // 暂停中的 blob 拒收分块（页面据此停发）
    const second = await manager.startBlob('second.bin', 3)
    manager.pause(second)
    expect(manager.saveChunk(second, Buffer.from('xyz').toString('base64'))).toBe(false)
    manager.cancel(second)
  })

  test('任务表跨重启恢复：在跑的任务变 paused，id 不复用', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    mkdirSync(downloadsDir(home), { recursive: true })
    writeFileSync(
      tasksFileOf(home),
      JSON.stringify([
        taskOf({ id: 7, status: 'downloading', targetPath: join(dir, 'a.bin'), filename: 'a.bin' }),
        taskOf({ id: 9, kind: 'blob', status: 'queued', targetPath: join(dir, 'b.bin'), filename: 'b.bin' }),
      ])
    )
    const manager = createDownloadManager({ home, downloadDir: dir, log: () => {}, fetchImpl: async () => new Response('') })
    const list = manager.list()
    expect(list.find((task) => task.id === 7)?.status).toBe('paused')
    expect(list.find((task) => task.id === 9)?.status).toBe('cancelled')
    const id = await manager.startBlob('new.bin', 1)
    expect(id).toBe(10)
  })

  test('清空已完成、并发上限夹取、在文件管理器里定位', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    const saved: number[] = []
    const revealed: string[] = []
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      saveConcurrency: (value) => saved.push(value),
      chooseDirectory: async () => dir,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      // 绝不能真弹 Finder（会打断人）：定位走注入的探针
      revealFile: (path) => {
        revealed.push(path)
        return true
      },
    })
    expect(manager.setConcurrency(99)).toBe(32)
    expect(manager.setConcurrency(0)).toBe(1)
    expect(saved).toEqual([32, 1])
    await manager.startUrl('http://h/done.bin', 'done.bin')
    await waitFor(() => manager.list()[0]?.status === 'completed')
    expect(manager.reveal(manager.list()[0]?.id ?? 0)).toBe(true)
    expect(revealed).toEqual([join(dir, 'done.bin')])
    expect(manager.clearFinished()).toBe(1)
    expect(manager.list()).toEqual([])
    // 未完成的任务不给定位
    expect(manager.reveal(999)).toBe(false)
  })

  test('stop()：中止在跑的传输并把非终态 URL 任务落成 paused', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      fetchImpl: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'))
          },
        })
        return new Response(stream, { status: 200 })
      },
    })
    await manager.startUrl('http://h/endless.bin', 'endless.bin')
    await waitFor(() => manager.list()[0]?.status === 'downloading')
    manager.stop()
    await waitFor(() => manager.list()[0]?.status === 'paused')
    const saved = JSON.parse(readFileSync(tasksFileOf(home), 'utf8')) as DownloadTask[]
    expect(saved[0]?.status).toBe('paused')
  })

  test('认证 cookie 只给壳对接的那个实例带（外部源不带凭据）', async () => {
    const home = tempDir('dsh-dl-home-')
    const dir = tempDir('dsh-dl-target-')
    const seen: Array<string | null> = []
    const manager = createDownloadManager({
      home,
      downloadDir: dir,
      log: () => {},
      chooseDirectory: async () => dir,
      cookieFor: (url) => (url.startsWith('http://127.0.0.1:3081/') ? 'dsh-auth-x=v1.sig' : null),
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('cookie'))
        return new Response('ok', { status: 200 })
      },
    })
    await manager.startUrl('http://127.0.0.1:3081/api/session.export', 'session.export')
    await waitFor(() => manager.list()[0]?.status === 'completed')
    await manager.startUrl('https://example.com/f.zip', 'f.zip')
    await waitFor(() => manager.list()[0]?.status === 'completed')
    expect(seen[0]).toBe('dsh-auth-x=v1.sig')
    expect(seen[1]).toBeNull()
  })
})
