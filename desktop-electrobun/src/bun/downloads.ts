// 下载管理器（旧壳 `desktop/src-tauri/src/download/{manager,transfer}.rs` 的等价物）。
//
// 唯一状态入口：任务表在内存里，每次状态变化都落盘（`$DSH_HOME/storages/downloads/tasks.json`）
// 并让面板的下一次轮询看到——前端不做事件订阅（客户端是 600ms 轮询 `list_downloads`）。
//
// 与旧壳的三处**有意差异**（都写进 CHANGELOG 与 #220）：
//   1. 保存位置不再是原生「保存框」，而是目录选择器 + 自动起名（`报告 (1).zip`）。
//      Electrobun 2.0.2 只暴露 `openFileDialog`，没有 NSSavePanel 封装；语义等价（用户选目录），
//      差别只在不能连带改文件名。
//   2. URL 下载的入口从 wry 的 `on_download` 换成页面拦截（`src/client/download-intercept.ts`）：
//      Electrobun 把 CEF 的下载事件暴露成 4 个 webview 事件，但**没有目的地/暂停/进度控制**，
//      所以想保留「选位置 + 暂停恢复 + Range 续传」就只能自己抓。没被抓住的下载（例如
//      `Content-Disposition: attachment` 触发的导航）仍由 CEF 自己存进 ~/Downloads。
//   3. 进度落盘节流到 1s（旧壳每次进度回调都写 tasks.json，即每 150ms 一次）。
//      面板读的是内存快照，所以「看得见的行为」不变，只是磁盘写入少两个数量级。

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  DEFAULT_CONCURRENCY,
  filenameFromUrl,
  isTerminal,
  MAX_TASKS,
  partPath,
  pruneTasks,
  recoverTasks,
  sanitizeFilename,
  sortTasks,
  uniqueTargetPath,
  type DownloadTask,
} from '../shared/downloads.ts'

/** 进度落盘节流：内存快照照旧每 150ms 更新，磁盘最多 1s 一次。 */
const PERSIST_THROTTLE_MS = 1_000
/** blob 分块上限（页面按 512KB 切；留一点余量给 base64 膨胀）。 */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

/** 传输用的 fetch 形状（`typeof fetch` 在 Bun 里带 `preconnect`，太宽；测试桩只需这个签名）。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface DownloadManagerOptions {
  /** `$DSH_HOME`（任务表落在 `<home>/storages/downloads/tasks.json`）。 */
  home: string
  log: (line: string) => void
  /** 完成时投递通知（旧壳 `SCENARIO.DOWNLOAD_COMPLETE`）。 */
  notify?: (filename: string) => void
  /** 让用户选目标目录（返回 null = 取消）。壳里接 Electrobun 的目录选择器。 */
  chooseDirectory?: (start: string) => Promise<string | null>
  /** 初始并发上限（设置里的 `download_concurrency`）。 */
  concurrency?: number
  /** 并发上限变化时回写设置。 */
  saveConcurrency?: (value: number) => void
  /**
   * 取该 URL 的会话 cookie（只有壳正在对接的那个 dsh 实例才带凭据；
   * 旧壳 `transfer.rs::auth_cookie_header` 同语义）。
   */
  cookieFor?: (url: string) => string | null
  fetchImpl?: FetchLike
  /** 默认下载目录（旧壳 `~/Downloads`；测试注入临时目录）。 */
  downloadDir?: string
  now?: () => number
  /** 在文件管理器里定位（默认真跑 `open -R` / explorer / xdg-open；测试必接，否则会真弹窗） */
  revealFile?: (path: string) => boolean
}

export interface DownloadManager {
  list: () => DownloadTask[]
  concurrency: () => number
  setConcurrency: (value: number) => number
  /** URL 任务入口（页面拦截 http(s) 下载锚点后调用）。 */
  startUrl: (url: string, suggested?: string | null) => Promise<number>
  /** blob 任务入口（页面拦截 blob:/data: 后调用）。 */
  startBlob: (filename: string, total: number | null) => Promise<number>
  /** blob 分块写入；返回 false 表示页面必须停发（任务被暂停/取消/失败）。 */
  saveChunk: (id: number, base64: string) => boolean
  finishBlob: (id: number) => boolean
  pause: (id: number) => void
  resume: (id: number) => void
  cancel: (id: number) => void
  clearFinished: () => number
  reveal: (id: number) => boolean
  /** 壳退出：中止传输、把非终态 URL 任务落成 paused（.part 留着下次续传）。 */
  stop: () => void
}

export function downloadsDir(home: string): string {
  return join(home, 'storages', 'downloads')
}

export function tasksFileOf(home: string): string {
  return join(downloadsDir(home), 'tasks.json')
}

export function createDownloadManager(options: DownloadManagerOptions): DownloadManager {
  const log = options.log
  const revealFile = options.revealFile ?? ((path: string): boolean => revealPath(path, log))
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000))
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const downloadDir = options.downloadDir ?? join(home0(), 'Downloads')
  const tasksFile = tasksFileOf(options.home)

  let concurrency = clampConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY)
  /** 新任务在前（列表顺序与 id 递减一致）。 */
  let tasks: DownloadTask[] = []
  let nextId = 1
  /** 进行中的 URL 传输（abort 句柄）。 */
  const running = new Map<number, AbortController>()
  /** 进行中的 blob 写入（.part 的文件描述符）。 */
  const blobFds = new Map<number, number>()
  let lastPersist = 0
  let stopped = false

  function home0(): string {
    return process.env['HOME'] ?? options.home
  }

  // ── 落盘 ────────────────────────────────────────────────

  function persist(force = true): void {
    if (!force) {
      const stamp = Date.now()
      if (stamp - lastPersist < PERSIST_THROTTLE_MS) return
      lastPersist = stamp
    }
    try {
      mkdirSync(downloadsDir(options.home), { recursive: true })
      const tmp = `${tasksFile}.tmp`
      writeFileSync(tmp, JSON.stringify(tasks, null, 2), { mode: 0o600 })
      renameSync(tmp, tasksFile)
    } catch (error) {
      // 下载管理不阻塞主流程：写不进去只记日志，下次状态变化再试
      log(`[downloads] 任务表落盘失败：${message(error)}`)
    }
  }

  function removePart(task: DownloadTask): void {
    try {
      rmSync(partPath(task), { force: true })
    } catch {
      /* 不存在或没权限：忽略 */
    }
  }

  function pruneIfNeeded(): void {
    const pruned = pruneTasks(tasks, MAX_TASKS)
    if (pruned.dropped.length === 0) return
    for (const task of pruned.dropped) removePart(task)
    tasks = pruned.tasks
    log(`[downloads] 历史裁剪：移除 ${String(pruned.dropped.length)} 条终态任务`)
  }

  // ── 任务表操作 ──────────────────────────────────────────

  function find(id: number): DownloadTask | undefined {
    return tasks.find((task) => task.id === id)
  }

  function update(id: number, patch: (task: DownloadTask) => DownloadTask, force = true): boolean {
    const index = tasks.findIndex((task) => task.id === id)
    if (index < 0) return false
    const current = tasks[index] as DownloadTask
    tasks[index] = { ...patch(current), updatedAt: now() }
    persist(force)
    return true
  }

  function add(kind: DownloadTask['kind'], url: string, filename: string, targetPath: string, total: number | null): DownloadTask {
    const stamp = now()
    const task: DownloadTask = {
      id: nextId,
      kind,
      url,
      filename,
      targetPath,
      total,
      received: 0,
      etag: null,
      resumed: false,
      status: 'choosing_path',
      error: null,
      createdAt: stamp,
      updatedAt: stamp,
    }
    nextId += 1
    tasks = [task, ...tasks]
    pruneIfNeeded()
    persist()
    return task
  }

  function fail(id: number, reason: string): void {
    log(`[downloads] 任务 ${String(id)} 失败：${reason}`)
    update(id, (task) => ({ ...task, status: 'failed', error: reason }))
  }

  // ── 并发闸门 ────────────────────────────────────────────

  function pump(): void {
    if (stopped) return
    while (running.size < concurrency) {
      const next = tasks.find((task) => task.kind === 'url' && task.status === 'queued' && !running.has(task.id))
      if (next === undefined) return
      const controller = new AbortController()
      running.set(next.id, controller)
      void runUrl(next.id, controller)
    }
  }

  // ── URL 传输（旧壳 transfer.rs） ────────────────────────

  async function runUrl(id: number, controller: AbortController): Promise<void> {
    const task = find(id)
    if (task === undefined) {
      running.delete(id)
      return
    }
    const part = partPath(task)
    let resumeFrom = 0
    try {
      resumeFrom = statSync(part).size
    } catch {
      resumeFrom = 0
    }
    let cookie: string | null = null
    try {
      cookie = options.cookieFor?.(task.url) ?? null
    } catch {
      cookie = null
    }

    const request = async (from: number, etag: string | null): Promise<Response> => {
      const headers = new Headers()
      if (cookie !== null && cookie !== '') headers.set('cookie', cookie)
      if (from > 0) {
        headers.set('range', `bytes=${String(from)}-`)
        if (etag !== null && etag !== '') headers.set('if-range', etag)
      }
      return await fetchImpl(task.url, { headers, signal: controller.signal, redirect: 'follow' })
    }

    try {
      let response = await request(resumeFrom, task.etag)
      if (response.status === 416 && resumeFrom > 0) {
        // 服务器不认 Range（或文件变了）：丢掉续传全量重下
        resumeFrom = 0
        update(id, (current) => ({ ...current, resumed: false }), false)
        response = await request(0, null)
      }
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const partial = response.status === 206 && resumeFrom > 0
      if (!partial) {
        resumeFrom = 0
        try {
          rmSync(part, { force: true })
        } catch {
          /* 忽略 */
        }
      }
      const lengthHeader = response.headers.get('content-length')
      const length = lengthHeader === null ? null : Number(lengthHeader)
      const total = length === null || !Number.isFinite(length) ? null : length + resumeFrom
      const etag = response.headers.get('etag')
      update(id, (current) => ({ ...current, status: 'downloading', total, etag, received: resumeFrom, resumed: partial }))

      // 目标目录可能还不存在（用户填的路径 / 拖走的 Download 目录）：先补上再开 .part
      mkdirSync(dirOf(part), { recursive: true })
      const fd = openSync(part, partial ? 'a' : 'w')
      let received = resumeFrom
      try {
        const body = response.body as unknown as AsyncIterable<Uint8Array> | null
        if (body === null) throw new Error('响应没有正文')
        for await (const chunk of body) {
          writeSync(fd, chunk)
          received += chunk.byteLength
          // 进度只动内存 + 节流落盘（面板轮询看到的就是这份内存快照）
          const index = tasks.findIndex((entry) => entry.id === id)
          if (index >= 0) {
            const current = tasks[index] as DownloadTask
            tasks[index] = { ...current, received, updatedAt: now() }
          }
          persist(false)
        }
      } finally {
        closeSync(fd)
      }
      completeUrl(id)
    } catch (error) {
      if (controller.signal.aborted) return // pause/cancel 已经写过状态
      fail(id, message(error))
    } finally {
      running.delete(id)
      pump()
    }
  }

  function completeUrl(id: number): void {
    const task = find(id)
    if (task === undefined) return
    const part = partPath(task)
    try {
      renameSync(part, task.targetPath)
    } catch (error) {
      fail(id, `保存失败：${message(error)}`)
      return
    }
    update(id, (current) => ({ ...current, status: 'completed', error: null }))
    log(`[downloads] 完成：${task.filename} → ${task.targetPath}`)
    options.notify?.(task.filename)
  }

  // ── 目标位置 ────────────────────────────────────────────

  async function chooseTarget(name: string): Promise<string | null> {
    const fallback = uniqueTargetPath(downloadDir, name, existsSync)
    if (options.chooseDirectory === undefined) return fallback
    let dir: string | null = null
    try {
      dir = await options.chooseDirectory(downloadDir)
    } catch (error) {
      log(`[downloads] 目录选择失败：${message(error)}`)
      dir = null
    }
    if (dir === null) return null
    return uniqueTargetPath(dir, name, existsSync)
  }

  // ── blob 管线 ───────────────────────────────────────────

  function closeBlob(id: number): void {
    const fd = blobFds.get(id)
    if (fd === undefined) return
    blobFds.delete(id)
    try {
      closeSync(fd)
    } catch {
      /* 忽略 */
    }
  }

  // ── 对外接口 ────────────────────────────────────────────

  // 启动时恢复（旧壳 persist::load_tasks）
  try {
    const raw = JSON.parse(readFileSync(tasksFile, 'utf8')) as unknown
    const recovered = recoverTasks(raw, now())
    tasks = sortTasks(recovered.tasks)
    for (const task of recovered.dropped) removePart(task)
    const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0)
    nextId = maxId + 1
    if (recovered.changed) persist()
    log(`[downloads] 恢复任务表：${String(tasks.length)} 条（含 ${String(recovered.dropped.length)} 条清理）`)
  } catch {
    // 文件不存在 / 坏 JSON：从空表开始（旧壳同语义）
    tasks = []
    nextId = 1
  }

  return {
    list: () => sortTasks(tasks).map((task) => ({ ...task })),

    concurrency: () => concurrency,

    setConcurrency: (value) => {
      concurrency = clampConcurrency(value)
      options.saveConcurrency?.(concurrency)
      log(`[downloads] 并发上限 = ${String(concurrency)}`)
      persist()
      pump()
      return concurrency
    },

    startUrl: async (url, suggested) => {
      const raw = (suggested ?? '').trim()
      const name = sanitizeFilename(raw === '' ? filenameFromUrl(url) : raw)
      const task = add('url', url, name, uniqueTargetPath(downloadDir, name, existsSync), null)
      const target = await chooseTarget(name)
      if (target === null) {
        update(task.id, (current) => ({ ...current, status: 'cancelled', error: '用户取消了保存位置' }))
        log(`[downloads] 取消（未选位置）：${name}`)
        return task.id
      }
      update(task.id, (current) => ({ ...current, targetPath: target, status: 'queued' }))
      pump()
      return task.id
    },

    startBlob: async (filename, total) => {
      const name = sanitizeFilename(filename)
      const task = add('blob', 'blob:', name, uniqueTargetPath(downloadDir, name, existsSync), total)
      const target = await chooseTarget(name)
      if (target === null) {
        update(task.id, (current) => ({ ...current, status: 'cancelled', error: '用户取消了保存位置' }))
        return task.id
      }
      const withTarget = { ...task, targetPath: target }
      try {
        mkdirSync(dirOf(target), { recursive: true })
        const fd = openSync(partPath(withTarget), 'w')
        blobFds.set(task.id, fd)
      } catch (error) {
        fail(task.id, `无法写入目标文件：${message(error)}`)
        return task.id
      }
      update(task.id, (current) => ({ ...current, targetPath: target, status: 'downloading' }))
      return task.id
    },

    saveChunk: (id, base64) => {
      const task = find(id)
      const fd = blobFds.get(id)
      if (task === undefined || fd === undefined || task.status !== 'downloading' || task.kind !== 'blob') {
        return false
      }
      let bytes: Uint8Array
      try {
        bytes = Buffer.from(base64, 'base64')
      } catch {
        return false
      }
      if (bytes.byteLength > MAX_CHUNK_BYTES) {
        fail(id, `分块过大（${String(bytes.byteLength)} 字节）`)
        closeBlob(id)
        return false
      }
      try {
        writeSync(fd, bytes)
      } catch (error) {
        fail(id, `写盘失败：${message(error)}`)
        closeBlob(id)
        return false
      }
      const index = tasks.findIndex((entry) => entry.id === id)
      if (index >= 0) {
        const current = tasks[index] as DownloadTask
        tasks[index] = { ...current, received: current.received + bytes.byteLength, updatedAt: now() }
      }
      persist(false)
      return true
    },

    finishBlob: (id) => {
      const task = find(id)
      if (task === undefined || task.kind !== 'blob' || task.status !== 'downloading') return false
      closeBlob(id)
      try {
        mkdirSync(dirOf(task.targetPath), { recursive: true })
        renameSync(partPath(task), task.targetPath)
      } catch (error) {
        fail(id, `保存失败：${message(error)}`)
        return false
      }
      update(id, (current) => ({ ...current, status: 'completed', error: null }))
      log(`[downloads] 完成：${task.filename} → ${task.targetPath}`)
      options.notify?.(task.filename)
      return true
    },

    pause: (id) => {
      const task = find(id)
      if (task === undefined || isTerminal(task.status) || task.status === 'paused') return
      const controller = running.get(id)
      if (controller !== undefined) controller.abort()
      if (task.kind === 'blob') closeBlob(id)
      update(id, (current) => ({ ...current, status: 'paused' }))
      log(`[downloads] 暂停：${task.filename}`)
    },

    resume: (id) => {
      const task = find(id)
      if (task === undefined) return
      if (task.kind === 'blob') {
        // blob 的源在页面内存里，暂停后无法续（旧壳同语义，客户端也标了「恢复(不可用)」）
        log(`[downloads] blob 任务无法续传：${task.filename}`)
        return
      }
      if (task.status !== 'paused' && task.status !== 'failed') return
      update(id, (current) => ({ ...current, status: 'queued', error: null }))
      pump()
    },

    cancel: (id) => {
      const task = find(id)
      if (task === undefined) return
      const controller = running.get(id)
      if (controller !== undefined) controller.abort()
      closeBlob(id)
      removePart(task)
      update(id, (current) => ({ ...current, status: 'cancelled', error: null }))
      log(`[downloads] 取消：${task.filename}`)
    },

    clearFinished: () => {
      const victims = tasks.filter((task) => isTerminal(task.status))
      if (victims.length === 0) return 0
      for (const task of victims) removePart(task)
      const ids = new Set(victims.map((task) => task.id))
      tasks = tasks.filter((task) => !ids.has(task.id))
      persist()
      return victims.length
    },

    reveal: (id) => {
      const task = find(id)
      if (task === undefined || task.status !== 'completed' || !existsSync(task.targetPath)) return false
      return revealFile(task.targetPath)
    },

    stop: () => {
      stopped = true
      for (const controller of running.values()) controller.abort()
      running.clear()
      for (const id of [...blobFds.keys()]) closeBlob(id)
      let touched = false
      for (const task of tasks) {
        if (task.kind === 'url' && task.status === 'downloading') {
          const index = tasks.findIndex((entry) => entry.id === task.id)
          tasks[index] = { ...task, status: 'paused', updatedAt: now() }
          touched = true
        }
      }
      if (touched) persist()
    },
  }
}

/** 在系统文件管理器里显示（macOS Finder / Windows 资源管理器 / Linux 目录）。 */
export function revealPath(path: string, log: (line: string) => void): boolean {
  const platform = process.platform
  const command =
    platform === 'darwin'
      ? ['open', '-R', path]
      : platform === 'win32'
        ? ['explorer', `/select,${path}`]
        : ['xdg-open', dirOf(path)]
  try {
    const child = Bun.spawn(command, { stdio: ['ignore', 'ignore', 'ignore'] })
    log(`[downloads] 定位文件：${command.join(' ')}`)
    // 不等它退出（文件管理器是长驻进程），但也不留僵尸
    void child.exited.catch(() => 0)
    return true
  } catch (error) {
    log(`[downloads] 定位失败：${message(error)}`)
    return false
  }
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path : path.slice(0, index)
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.trunc(value)))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
