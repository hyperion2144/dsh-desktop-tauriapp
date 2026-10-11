// 下载管理器：任务模型与纯策略（旧壳 `desktop/src-tauri/src/download/{model,persist}.rs` 的等价物）。
//
// 这个文件不碰 IO，只有状态机与命名/恢复/裁剪策略，便于单测：
//   · 状态机：choosing_path → queued → downloading → completed/failed/cancelled（paused 可回 queued）
//   · 跨重启恢复：非终态的 URL 任务恢复成 paused（.part 留着续传）；blob 任务恢复成 cancelled
//     并清 .part——blob 的源在页面内存里，页面一重载就没了
//   · 历史裁剪：超过 MAX_TASKS 时按 updatedAt 淘汰最老的**终态**任务（非终态永不裁剪）
//
// 任务对象同时是「前端列表的数据源」与 tasks.json 的落盘格式（单一事实源），字段名照旧壳用 camelCase。

export type DownloadStatus =
  | 'choosing_path'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 任务来源：URL 直链（壳自己流式下载，支持 Range 续传）或页面 blob/data（页面分块交壳写盘）。 */
export type DownloadKind = 'url' | 'blob'

export interface DownloadTask {
  id: number
  kind: DownloadKind
  /** 来源 URL（blob 任务为触发页 origin，仅展示用）。 */
  url: string
  /** 展示文件名（也是目标文件名的默认值）。 */
  filename: string
  /** 目标绝对路径。 */
  targetPath: string
  /** 总字节数（服务器 Content-Length；未知为 null）。 */
  total: number | null
  /** 已写字节数（URL 任务 = .part 长度；blob 任务 = 已收分块和）。 */
  received: number
  /** 上次成功响应的 ETag（续传时作 If-Range 校验）。 */
  etag: string | null
  /** 本次传输是否为续传（服务器不支持时回退全量重下并把该标志复位）。 */
  resumed: boolean
  status: DownloadStatus
  error: string | null
  /** unix 秒。 */
  createdAt: number
  updatedAt: number
}

/** 历史记录上限（旧壳拍板：约 200 条，超限自动裁剪最老终态任务）。 */
export const MAX_TASKS = 200
/** .part 临时文件后缀（与目标同目录，保证最终 rename 不跨卷）。 */
export const PART_SUFFIX = '.part'
/** 并发上限取值范围（旧壳 `set_download_concurrency` 同口径）。 */
export const CONCURRENCY_MIN = 1
export const CONCURRENCY_MAX = 32
export const DEFAULT_CONCURRENCY = 3

const TERMINAL: readonly DownloadStatus[] = ['completed', 'failed', 'cancelled']

export function isTerminal(status: DownloadStatus): boolean {
  return TERMINAL.includes(status)
}

/** 文件名清洗：去路径分隔符与控制字符、去首尾空白与点、截断 120 字符、空则回退 `download`。 */
export function sanitizeFilename(raw: string): string {
  const cleaned = Array.from(raw, (ch) =>
    ch.charCodeAt(0) < 0x20 || ch === '/' || ch === '\\' || ch === ':' ? '_' : ch
  ).join('')
  const trimmed = cleaned.trim().replace(/^\.+/, '').replace(/\.+$/, '')
  if (trimmed === '') return 'download'
  return Array.from(trimmed).slice(0, 120).join('')
}

/** 从 URL 尾段提取文件名（目录选择框的默认名候选）。 */
export function filenameFromUrl(url: string): string {
  // 照旧壳 `filename_from_url`：取最后一个 `/` 之后、`?` 之前的那段（不解析 authority，
  // 所以 `http://h/` 与裸字符串的空尾段一样回 `download`）。
  const tail = url.slice(url.lastIndexOf('/') + 1)
  const last = tail.split('?')[0] ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    decoded = last // 非法 %XX：原样用
  }
  return sanitizeFilename(decoded)
}

/** 任务的 .part 路径：与目标同目录、文件名加 `.part`。 */
export function partPath(task: Pick<DownloadTask, 'targetPath' | 'filename'>): string {
  const separator = task.targetPath.includes('\\') && !task.targetPath.includes('/') ? '\\' : '/'
  const dir = task.targetPath.slice(0, task.targetPath.length - basenameLength(task.targetPath))
  return `${dir}${sanitizeFilename(task.filename)}${PART_SUFFIX}` || `${task.targetPath}${PART_SUFFIX}`
}

/** 路径里的最后一段长度（含分隔符）——用于把目录部分切出来。 */
function basenameLength(path: string): number {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? path.length : path.length - index - 1
}

/** 默认下载目录（旧壳 `dirs_like_download_dir`：`~/Downloads`）。 */
export function defaultDownloadDir(home: string): string {
  const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return home.endsWith(separator) ? `${home}Downloads` : `${home}${separator}Downloads`
}

/**
 * 目录里挑一个不撞车的目标名：`报告.zip` 已存在（或它的 .part 已存在）时退成 `报告 (1).zip`，
 * 与浏览器行为一致（不静默覆盖）。`exists` 由调用方注入（IO 在 manager 里）。
 */
export function uniqueTargetPath(dir: string, filename: string, exists: (path: string) => boolean): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const base = separator === '\\' ? `${dir}\\` : dir.endsWith('/') ? dir : `${dir}/`
  const name = sanitizeFilename(filename)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = `${base}${name}`
  let index = 1
  while (exists(candidate) || exists(`${candidate}${PART_SUFFIX}`)) {
    candidate = `${base}${stem} (${index})${ext}`
    index += 1
  }
  return candidate
}

/** 恢复语义：跨重启时非终态任务整备（blob 作废、URL 转 paused），并把时间戳推进。 */
export function recoverTask(task: DownloadTask, now: number): { task: DownloadTask; droppedPart: boolean } {
  if (isTerminal(task.status)) return { task, droppedPart: false }
  if (task.kind === 'blob') {
    return {
      task: {
        ...task,
        status: 'cancelled',
        error: '页面已重载，blob 数据不可恢复',
        updatedAt: now,
      },
      droppedPart: true,
    }
  }
  return { task: { ...task, status: 'paused', updatedAt: now }, droppedPart: false }
}

export interface RecoverResult {
  tasks: DownloadTask[]
  /** 需要清理 .part 的任务（blob 作废 / 被裁剪的终态任务）。 */
  dropped: DownloadTask[]
  /** 是否发生了恢复动作（调用方据此决定要不要回写 tasks.json）。 */
  changed: boolean
}

/** 解析落盘的 JSON（坏数据一律丢弃，不抛）并做恢复 + 裁剪。 */
export function recoverTasks(raw: unknown, now: number, limit = MAX_TASKS): RecoverResult {
  const list = Array.isArray(raw) ? raw : []
  const dropped: DownloadTask[] = []
  let changed = false
  const tasks: DownloadTask[] = []
  for (const entry of list) {
    const task = parseTask(entry)
    if (task === null) {
      changed = true
      continue
    }
    const recovered = recoverTask(task, now)
    if (recovered.task !== task) changed = true
    if (recovered.droppedPart) dropped.push(recovered.task)
    tasks.push(recovered.task)
  }
  const pruned = pruneTasks(tasks, limit)
  if (pruned.tasks.length !== tasks.length) changed = true
  dropped.push(...pruned.dropped)
  return { tasks: pruned.tasks, dropped, changed }
}

/** 裁剪：超限时从最老的终态任务开始移除（连带 .part），非终态永不裁剪。 */
export function pruneTasks(
  tasks: DownloadTask[],
  limit = MAX_TASKS
): { tasks: DownloadTask[]; dropped: DownloadTask[] } {
  if (tasks.length <= limit) return { tasks, dropped: [] }
  const victims = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => isTerminal(task.status))
    .sort((left, right) => left.task.updatedAt - right.task.updatedAt)
    .slice(0, tasks.length - limit)
  const victimIds = new Set(victims.map(({ task }) => task.id))
  return {
    tasks: tasks.filter((task) => !victimIds.has(task.id)),
    dropped: victims.map(({ task }) => task),
  }
}

/** 宽松解析一条落盘记录：缺关键字段/类型不对就丢弃（返回 null）。 */
function parseTask(raw: unknown): DownloadTask | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = record.id
  const kind = record.kind
  const targetPath = record.targetPath
  const filename = record.filename
  const status = record.status
  if (typeof id !== 'number' || !Number.isFinite(id)) return null
  if (kind !== 'url' && kind !== 'blob') return null
  if (typeof targetPath !== 'string' || targetPath === '') return null
  if (typeof filename !== 'string' || filename === '') return null
  if (typeof status !== 'string' || !isStatus(status)) return null
  const url = typeof record.url === 'string' ? record.url : ''
  const total = typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : null
  const received = typeof record.received === 'number' && Number.isFinite(record.received) ? record.received : 0
  const etag = typeof record.etag === 'string' ? record.etag : null
  const error = typeof record.error === 'string' ? record.error : null
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : createdAt
  return {
    id,
    kind,
    url,
    filename,
    targetPath,
    total,
    received,
    etag,
    resumed: record.resumed === true,
    status,
    error,
    createdAt,
    updatedAt,
  }
}

function isStatus(value: string): value is DownloadStatus {
  return (
    value === 'choosing_path' ||
    value === 'queued' ||
    value === 'downloading' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
}

/** 进度百分比（总长未知时回 null；UI 自己决定怎么画）。 */
export function progressPercent(task: Pick<DownloadTask, 'received' | 'total'>): number | null {
  if (task.total === null || task.total <= 0) return null
  return Math.min(100, Math.round((task.received / task.total) * 100))
}

/** 列表排序：新任务在前（id 降序）——与旧壳「新任务在前」一致。 */
export function sortTasks(tasks: readonly DownloadTask[]): DownloadTask[] {
  return [...tasks].sort((left, right) => right.id - left.id)
}
