// 下载管理器右侧边栏 Tab + 会话 header 按钮（#72）。
//
// 注册模型照抄 dsh-context 的防御式可选注入：sidebarRightTabs 服务不存在
// （老版 dsh / 未装 sidebar-right）时静默不注册，绝不搞挂页面；better-sidebar
// ≥0.19 右列即原生右列，本注册天然双适应。
// 数据源：轮询 invoke list_downloads（远程 origin 只有 __TAURI_INTERNALS__ 单
// IPC 通道，event.listen 不可用；tab 打开时 600ms 轮询，空闲降频）。
// 主题只用 --dsw-alias-* 变量（带回退），禁 hash 类名（仓库血泪坑 #8）。
import type { ClientContext } from './ctx-types.ts'
import { Button, IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import React, { useEffect, useRef, useState } from 'react'

/** 与 Rust download::model::DownloadTask 对齐（serde camelCase）。 */
interface DownloadTask {
  id: number
  kind: 'url' | 'blob'
  url: string
  filename: string
  targetPath: string
  total: number | null
  received: number
  etag: string | null
  resumed: boolean
  status: 'choosing_path' | 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
  error: string | null
  createdAt: number
  updatedAt: number
}

const TAB_ID = 'dsh-desktop-tauriapp/downloads'
const TAB_KIND = 'dsh-desktop-tauriapp/downloads'

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> }
    __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> } }
  }
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args)
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args)
  return Promise.reject(new Error('no tauri ipc'))
}

function hasIpc(): boolean {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown }
    __TAURI__?: { core?: { invoke?: unknown } }
  }
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke)
}

// ── 数据源：轮询 store ─────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const STATUS_LABEL: Record<DownloadTask['status'], string> = {
  choosing_path: '等待选择位置',
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 列表面板（React；样式内联 + 少量 --dsw-alias-* 变量）。 */
function DownloadsPanel(): React.ReactElement {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [concurrency, setConcurrency] = useState<number>(3)
  const [busy, setBusy] = useState(false)
  const timerRef = useRef<number | null>(null)
  const tasksRef = useRef<DownloadTask[]>([])

  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const list = await invoke<DownloadTask[]>('list_downloads')
        const settings = await invoke<{ concurrency: number }>('get_download_settings')
        if (!alive) return
        setTasks(list)
        setConcurrency(settings.concurrency)
      } catch {
        /* IPC 失败保持上次数据 */
      }
    }
    void refresh()
    const tick = (): void => {
      void refresh()
      const active = tasksRef.current.some((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'choosing_path')
      timerRef.current = window.setTimeout(tick, active ? 600 : 2500)
    }
    timerRef.current = window.setTimeout(tick, 600)
    return () => {
      alive = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  tasksRef.current = tasks // 镜像最新列表：tick 闭包只建一次，必须读 ref

  const act = async (cmd: string, args: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await invoke(cmd, args)
    } catch {
      /* 动作失败：下次轮询自然回真 */
    } finally {
      setBusy(false)
    }
  }

  const finishedCount = tasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l, rgba(255,255,255,.08))' }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary, #9aa3af)' }}>并发 {concurrency}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={busy || finishedCount === 0}
          onClick={() => void act('clear_finished_downloads', {})}
          style={{ padding: '2px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l, rgba(255,255,255,.14))', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
        >
          清空已完成
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {tasks.length === 0 ? (
          <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary, #6b7280)' }}>
            暂无下载任务。页面里的下载（session log、文件等）会出现在这里。
          </div>
        ) : (
          tasks.map((t) => (
            <div key={t.id} style={{ padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l, rgba(255,255,255,.05))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary, #e7eaf0)' }} title={t.filename}>
                  {t.filename}
                </span>
                <span style={{ color: 'var(--dsw-alias-label-tertiary, #6b7280)', fontSize: 11 }}>{STATUS_LABEL[t.status]}</span>
              </div>
              {(t.status === 'downloading' || t.status === 'queued' || t.status === 'paused') && (
                <div style={{ marginTop: 5 }}>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: t.total ? `${Math.min(100, (t.received / t.total) * 100)}%` : '0%',
                        background: 'var(--dsw-alias-brand-primary-new-color, #4176e6)',
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, color: 'var(--dsw-alias-label-tertiary, #6b7280)', fontSize: 11 }}>
                    <span>
                      {fmtBytes(t.received)}
                      {t.total ? ` / ${fmtBytes(t.total)}` : ''}
                      {t.resumed ? ' · 续传' : ''}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }} title={t.targetPath}>
                      {t.targetPath}
                    </span>
                  </div>
                </div>
              )}
              {t.error != null && (
                <div style={{ marginTop: 3, color: '#f87171', fontSize: 11 }} title={t.error}>
                  {t.error}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                {(t.status === 'downloading' || t.status === 'queued') && (
                  <TextButton onClick={() => void act('pause_download', { id: t.id })}>暂停</TextButton>
                )}
                {(t.status === 'paused' || t.status === 'failed') && (
                  <TextButton onClick={() => void act('resume_download', { id: t.id })}>
                    {t.status === 'paused' && t.kind === 'blob' ? '恢复(不可用)' : '恢复'}
                  </TextButton>
                )}
                {!['completed', 'cancelled'].includes(t.status) && (
                  <TextButton onClick={() => void act('cancel_download', { id: t.id })}>取消</TextButton>
                )}
                {t.status === 'completed' && (
                  <TextButton onClick={() => void act('reveal_download', { id: t.id })}>在文件管理器中显示</TextButton>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function TextButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '1px 8px',
        fontSize: 11,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l, rgba(255,255,255,.14))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

/** tab chip 标题（官方图标 + 文字，照抄 dsh-context 的 title seat 模式）。 */
function DownloadsTabTitle(): React.ReactElement {
  return (
    <>
      <IconDownloadOutline16 />
      <span style={{ marginLeft: 4 }}>下载</span>
    </>
  )
}

/** 会话 header 右上角「下载管理器」按钮：dsh 官方 Button（toolbar 变体，
 * hover/active 由官方 --dsw-alias-button-* token 家族接管，与宿主工具按钮
 * 行为完全同源——不自绘样式，杜绝常态高亮这类自造轮子问题）。 */
function DownloadsHeaderButton(): React.ReactElement {
  return (
    <Button
      variant="toolbar"
      size="sm"
      icon={<IconDownloadOutline16 />}
      title="下载管理器"
      aria-label="下载管理器"
      onClick={() => {
        if (headerOpenAction) headerOpenAction()
      }}
    />
  )
}

/** header 按钮的打开动作（注册层设置；避免组件直接依赖 cordis ctx 类型）。 */
let headerOpenAction: (() => void) | null = null

// ── 注册层：防御式可选注入（照抄 dsh-context watchSidebarContextTab） ───

type SlotsService = {
  inject: (name: string, fn: () => void) => unknown
  register: (meta: Record<string, unknown>, comp: unknown) => unknown
}

export function registerDownloadsTab(ctx: ClientContext): void {
  if (!hasIpc()) {
    ctx?.logger?.warn?.('downloads-tab: 无 Tauri IPC（纯浏览器），跳过注册')
    return
  }
  const root = ctx as unknown as {
    inject: (deps: string[], cb: (sub: Record<string, unknown>) => void) => { dispose?: () => void } | undefined
    get?: (name: string) => unknown
  }
  // 服务不存在（老版 dsh）时回调不触发、不注册、不报错
  root.inject(['sidebarRightTabs'], (sub) => {
    const disposers: Array<() => void> = []
    const own = (r: unknown): void => {
      if (typeof r === 'function') disposers.push(r)
    }
    try {
      const tabs = sub.sidebarRightTabs as { register: unknown } | undefined
      const slots = sub.slots as SlotsService | undefined
      if (tabs === undefined || typeof tabs.register !== 'function') return
      if (slots === undefined || typeof slots.register !== 'function') return
      own(tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => '下载',
        guide: [
          {
            id: 'downloads',
            order: 30,
            title: () => '下载',
            description: () => '桌面壳下载管理器：进度、暂停/恢复、并行与历史',
            icon: IconDownloadOutline16,
          },
        ],
      }))
      own(slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, DownloadsPanel),
      ))
      own(slots.inject('sidebar.right.pane.tab.title', () =>
        slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, DownloadsTabTitle),
      ))
    } catch {
      for (const dispose of disposers) dispose()
      return
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // 会话 header 右上角按钮（utilities 席位）：点击 openTab 打开右列 + 下载 tab
  root.inject(['slots'], (sub) => {
    const slots = sub.slots as SlotsService | undefined
    if (slots === undefined || typeof slots.register !== 'function') return
    try {
      headerOpenAction = () => {
        const sidebarRight = (ctx as unknown as { get?: (n: string) => { openTab?: (kind: string) => void } }).get?.('sidebarRight')
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          sidebarRight.openTab(TAB_KIND)
        }
      }
      // list 席位的注册 meta 是 { name, id, order, registrant }（对照
      // better-sidebar bottom-toggle 的活例；sidebar-right 的 key 型 meta 在此无效）
      const dispose = slots.inject('conversation.session.header.utilities', () =>
        slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-desktop-tauriapp:downloads-button',
          order: 20, // better-sidebar 开合钮 order=10，排其后
          registrant: 'dsh-desktop-tauriapp',
        }, DownloadsHeaderButton),
      )
      if (typeof dispose === 'function') return dispose
    } catch {
      /* header 席位注册失败：仅少了入口按钮，右列 tab 与引导页仍可用 */
    }
    return undefined
  })
}
