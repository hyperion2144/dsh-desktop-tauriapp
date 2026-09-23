// 桌面设置 Tab：托盘设置能力全部迁移至此。
// 区块：dsh 来源 / dsh 服务地址 / Profile / Profile 端口 / 迁移 Profile / dsh 运行时 / 本地端口 / 下载 / 代理设置 / 消息条。
// 纯 React JSX + hooks 重写（先前是 React 入口 + document.createElement 手拼 DOM 的混合写法，已被否决）：
// 禁止 document.createElement / innerHTML / appendChild，UI 全部由 JSX 返回；状态 useState/useEffect/useCallback 声明式管理。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from './ctx-types.ts'

import { ThemeSelect } from './theme-select.tsx'
export const inject = ['slots']

// dsh settings 服务的桌面壳命名空间 RPC 通道（宿主 index.js 注册）。
// 所有设置项持久化走此通道（宿主侧 ctx.settings.get/mutate），不直接读写 settings.yaml；
// Tauri IPC 仅保留只读回显（get_proxy_settings 的 effective 预览、profile 目录扫描）与动作（重启/连通性测试/运行时刻录读取）。
const NS_CHANNEL = '/dsh-desktop-fuse-settings'

interface NsRpc {
  rpc: { call: (channel: string, endpoint: string, payload?: unknown) => Promise<NsRpcResponse> }
}
interface NsRpcResponse {
  ok?: boolean
  error?: { message?: string }
  value?: unknown
}

let nsRpc: NsRpc | null = null

function hasIpc(): boolean {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown }
    __TAURI__?: { core?: { invoke?: unknown } }
  }
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke)
}

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> }
    __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> } }
  }
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args)
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__?.core.invoke(cmd, args)
  return Promise.reject(new Error('no tauri ipc'))
}


interface ProxySettings {
  proxy_mode: string
  proxy_url: string
  no_proxy: string
  proxy_user: string
  proxy_pass: string
  effective?: { http?: string; https?: string; all?: string; no_proxy?: string }
}

interface DesktopData {
  remote_addr: string | null
  remote_list: string[]
  port: number
  profiles: Array<{ name: string; active: boolean; selectable: boolean }>
}

interface DshSourceState {
  mode: string
  builtin: { dsh_version: string } | null
  external: { dsh_version: string; path: string } | null
  running: { mode: string; origin: string; port: number; version?: string } | null
}

interface ProfilePortRow {
  profile: string
  port: number
  lane_port: number
  running: boolean
}

interface RuntimeCatalog {
  source: string
  builtin: string | null
  selected: string | null
  installed: { version: string }[]
  catalog: { version: string; channel: string }[]
  /** #107：目录拉取失败时的降级标记（此时 catalog 为空、installed 为本地全部已装） */
  error?: string
}

interface MigrationStatus {
  running: boolean
  copied: number
  total: number
}

interface BannerMsg {
  ok: boolean
  text: string
}

// ── 样式：PANEL_CSS 装一份挂在 [data-desktop-settings] 下的类名样式（按钮/输入框/标签/小字注等复用样式）；
//    其他局部样式直接用 JSX style 对象，视觉与原 cssText 等价。
const PANEL_CSS = `
[data-desktop-settings] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s; }
[data-desktop-settings] .pf-btn:hover { filter:brightness(1.12); }
[data-desktop-settings] .pf-btn:active { transform:translateY(1px); }
[data-desktop-settings] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-desktop-settings] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-desktop-settings] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-desktop-settings] .pf-btn.danger { background:transparent; border:1px solid var(--dsw-alias-state-danger-primary,#e5534b); color:var(--dsw-alias-state-danger-primary,#e5534b); }
[data-desktop-settings] .pf-btn.danger:hover { background:rgba(229,83,75,.12); filter:none; }
[data-desktop-settings] .pf-btn:disabled { opacity:.5; cursor:not-allowed; }
[data-desktop-settings] input, [data-desktop-settings] select { padding:6px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l,#ffffff1f); background:var(--dsw-alias-bg-base,#151517); color:inherit; font-size:12px; }
[data-desktop-settings] .pf-label { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-bottom:4px; }
[data-desktop-settings] .pf-input { width:100%; box-sizing:border-box; }
[data-desktop-settings] .pf-title { font-weight:600; font-size:13px; margin-bottom:10px; }
[data-desktop-settings] .pf-row { display:flex; gap:8px; align-items:center; }
[data-desktop-settings] .pf-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; word-break:break-all; }
`

let stylesInstalled = false
function ensureStyles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  const style = document.createElement('style')
  style.dataset.desktopSettings = 'styles'
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

// JSX 用样式对象（与 PANEL_CSS 视觉一致）。
const ROOT_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 680,
  fontSize: 13,
}
const SECTION_STYLE: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
  borderRadius: 12,
  padding: '14px 16px',
}
const TITLE_STYLE: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  marginBottom: 10,
}
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
  marginBottom: 4,
}
const NOTE_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
  marginTop: 8,
  wordBreak: 'break-all',
}
const INPUT_BASE_STYLE: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
  background: 'var(--dsw-alias-bg-base,#151517)',
  color: 'inherit',
  fontSize: 12,
}
const INPUT_FULL_STYLE: React.CSSProperties = { ...INPUT_BASE_STYLE, width: '100%', boxSizing: 'border-box' }
const ROW_STYLE: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
const FLEX_1_STYLE: React.CSSProperties = { flex: 1 }

const BTN_PRIMARY_STYLE: React.CSSProperties = {
  background: 'var(--dsw-alias-brand-primary-new-color,#4176e6)',
  border: 'none',
  color: '#fff',
  borderRadius: 8,
  padding: '6px 13px',
  fontSize: 12,
  cursor: 'pointer',
}
const BTN_GHOST_STYLE: React.CSSProperties = {
  ...BTN_PRIMARY_STYLE,
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
  color: 'var(--dsw-alias-label-primary,#e7eaf0)',
}
const BTN_DANGER_STYLE: React.CSSProperties = {
  ...BTN_PRIMARY_STYLE,
  background: 'transparent',
  border: '1px solid var(--dsw-alias-state-danger-primary,#e5534b)',
  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
}
const DANGER_NOTE_STYLE: React.CSSProperties = {
  ...NOTE_STYLE,
  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
}
const SUCCESS_NOTE_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-success-primary,#2fbf71)',
}
const DANGER_MSG_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
}

// ── 持久化通道（nsSave / nsGet）──
// #95 v0.1.7：dsh 废除 settings.yaml 插件命名空间——壳设置搬出 dsh，
// 走壳自己的 Tauri IPC（Rust 单写者，$DSH_HOME/desktop-settings.json），不再经宿主 RPC。
async function nsSave(patch: Record<string, unknown>): Promise<void> {
  await invoke('save_desktop_settings', { patch })
}

async function nsGet(): Promise<Record<string, unknown>> {
  // 读侧走既有 get_desktop_settings_data 的设置段（同一 Rust 读源）
  const d = await invoke<{ settings?: Record<string, unknown> }>('get_desktop_settings_data')
  return (d.settings && typeof d.settings === 'object' ? d.settings : {}) as Record<string, unknown>
}
// 地址归一化（对齐 Rust normalize_remote_url 核心规则）：完整 URL 或 host[:port]。
function normalizeRemote(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  if (/^https?:\/\//.test(t)) return t
  if (/^socks5:\/\//.test(t)) return t
  if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(t)) return `https://${t}`
  return null
}

// ── 小工具组件 ──────────────────────────────────────
function SectionBox({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={SECTION_STYLE}>
      <div style={TITLE_STYLE}>{title}</div>
      {children}
    </div>
  )
}

function PfBtn({
  variant = 'primary',
  disabled = false,
  onClick,
  children,
  style,
  title,
}: {
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  style?: React.CSSProperties
  title?: string
}): React.ReactElement {
  const baseStyle =
    variant === 'primary' ? BTN_PRIMARY_STYLE : variant === 'ghost' ? BTN_GHOST_STYLE : BTN_DANGER_STYLE
  const cls = variant === 'primary' ? 'pf-btn' : `pf-btn ${variant}`
  return (
    <button
      type="button"
      className={cls}
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{ ...baseStyle, ...(style ?? {}) }}
    >
      {children}
    </button>
  )
}


// 全局 toast：挂 document.body，不依赖设置面板是否打开。
function showToast(text: string, ok: boolean): void {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:500;max-width:480px;box-shadow:0 4px 12px rgba(0,0,0,.4);cursor:pointer;backdrop-filter:blur(8px);${ok ? 'background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.6);color:#4ade80' : 'background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.6);color:#f87171'}`
  el.textContent = text
  el.addEventListener('click', () => el.remove())
  document.body.appendChild(el)
  if (ok) window.setTimeout(() => el.remove(), 5000)
}
// ── 主组件 ──────────────────────────────────────────
function DesktopSettingsPanel(): React.ReactElement {
  const [proxy, setProxy] = useState<ProxySettings>({
    proxy_mode: 'off',
    proxy_url: '',
    no_proxy: '',
    proxy_user: '',
    proxy_pass: '',
  })
  const [proxyEffective, setProxyEffective] = useState<ProxySettings['effective']>(undefined)
  const [desktop, setDesktop] = useState<DesktopData>({
    remote_addr: null,
    remote_list: [],
    port: 3080,
    profiles: [],
  })
  const [msg, setMsg] = useState<BannerMsg | null>(null)
  const [busy, setBusy] = useState(false)
  // 成功 toast 4 秒自动消失；错误 toast 手动点击关闭
  useEffect(() => {
    if (msg && msg.ok) {
      const t = window.setTimeout(() => setMsg(null), 4000)
      return () => window.clearTimeout(t)
    }
  }, [msg])

  // dsh 来源（内置 / 外部）
  const [sourceState, setSourceState] = useState<DshSourceState | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)

  // dsh 服务地址
  const [newRemoteUrl, setNewRemoteUrl] = useState('')

  // 本地端口
  const [portDraft, setPortDraft] = useState('')

  // 下载
  const [concurrencyInput, setConcurrencyInput] = useState<string>('3')
  const concurrencyTouchedRef = useRef(false)

  // 代理测试
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState(false)

  // Profile 端口（保留原 retry 逻辑）
  const [profilePorts, setProfilePorts] = useState<ProfilePortRow[]>([])
  const [profilePortsStatus, setProfilePortsStatus] = useState<{
    state: 'loading' | 'ok' | 'error'
    text?: string
  }>({ state: 'loading', text: '加载中…' })
  const [profilePortInputs, setProfilePortInputs] = useState<Record<string, string>>({})
  const [profilePortBoxNote, setProfilePortBoxNote] = useState<string | null>(null)

  // 迁移
  const [migrationSource, setMigrationSource] = useState('')
  const [migrationDest, setMigrationDest] = useState('')
  const [migrationRunning, setMigrationRunning] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<{ copied: number; total: number } | null>(null)

  // 运行时
  const [runtimeSource, setRuntimeSource] = useState<'github' | 'npm'>('github')
  const [runtimeStatus, setRuntimeStatus] = useState<{
    state: 'loading' | 'ok' | 'error'
    text?: string
  }>({ state: 'loading', text: '读取中…' })
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimeCatalog | null>(null)
  // 下载状态：'downloading' | 'downloaded' | { failed: 原因 }（#95 评论：失败必须带原因展示）
  const [runtimeDownloading, setRuntimeDownloading] = useState<
    Record<string, 'downloading' | 'downloaded' | { failed: string }>
  >({})
  // #110：卸载中的版本（行级禁用态；删除可能数秒，期间按钮显示「卸载中…」）
  const [removingVersion, setRemovingVersion] = useState<string | null>(null)
  // pnpm 安装进度（后端轮询；remote 页 event.listen 不可用）
  const [dlProgress, setDlProgress] = useState<{
    version: string
    resolved: number
    downloaded: number
    added: number
  } | null>(null)
  // 版本目录折叠（#95：列表太长，默认只显示各渠道头版 + 已安装）
  const [runtimeExpanded, setRuntimeExpanded] = useState(false)

  // 下载 section 内嵌反馈（保留原 note(box, …) 行为）
  const [downloadBoxNote, setDownloadBoxNote] = useState<string | null>(null)

  // 通用长任务状态（#95 拒绝静默）：新建/迁移的任务卡全程可见
  const [taskInfo, setTaskInfo] = useState<{
    running: boolean
    finished: boolean
    kind: string
    title: string
    stage: string
    done: number
    total: number
    error: string
    result: string
  } | null>(null)
  useEffect(() => {
    const timer = setInterval(() => {
      void invoke<{
        running: boolean; finished: boolean; kind: string; title: string; stage: string;
        done: number; total: number; error: string; result: string
      }>('task_status')
        .then((t) => {
          // 任务开启或进行中刷新；结束后保留末态（直到下一次任务开始）
          if (t.running || t.finished) setTaskInfo(t)
        })
        .catch(() => {})
    }, 600)
    return () => clearInterval(timer)
  }, [])

  // ── 加载样式与初始数据 ──
  useEffect(() => {
    ensureStyles()
  }, [])

  // #95 评论 Bug 3：弹窗重开时恢复后台下载中的状态（后端 DL_ACTIVE 仍 true）
  useEffect(() => {
    void invoke<{ active: boolean; version: string }>('runtime_download_status')
      .then((s) => {
        if (s.active && s.version) {
          setRuntimeDownloading((prev) => ({ ...prev, [s.version]: 'downloading' }))
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [ns, p, d] = await Promise.all([
          nsGet(),
          invoke<ProxySettings>('get_proxy_settings'),
          invoke<DesktopData>('get_desktop_settings_data'),
        ])
        if (cancelled) return
        setProxy({
          proxy_mode: (ns.proxy_mode as string) || p.proxy_mode || 'off',
          proxy_url: (ns.proxy_url as string) || p.proxy_url || '',
          no_proxy: (ns.no_proxy as string) || p.no_proxy || '',
          proxy_user: (ns.proxy_user as string) || p.proxy_user || '',
          proxy_pass: (ns.proxy_pass as string) || p.proxy_pass || '',
        })
        setProxyEffective(p.effective)
        setDesktop({
          remote_addr: (ns.remote_addr as string | null) ?? null,
          remote_list: (ns.remote_list as string[]) ?? d.remote_list ?? [],
          port: (ns.port as number) || d.port || 3080,
          profiles: d.profiles,
        })
        // 迁移 select 默认填充：源取第一个，目标取另一个（保持原 fillDst 行为）。
        if (d.profiles.length > 0) {
          const first = d.profiles[0]
          if (first) {
            setMigrationSource(first.name)
            const other = d.profiles.find((pp) => pp.name !== first.name)
            if (other) setMigrationDest(other.name)
          }
        }
      } catch (err) {
        if (cancelled) return
        setMsg({ ok: false, text: `读取设置失败：${String(err)}` })
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── dsh 来源刷新 ──
  const refreshSource = useCallback(async (): Promise<void> => {
    setSourceError(null)
    try {
      const s = await invoke<DshSourceState>('get_dsh_source')
      setSourceState(s)
    } catch (err) {
      setSourceError(String(err))
    }
  }, [])

  useEffect(() => {
    void refreshSource()
  }, [refreshSource])

  // ── 下载并发上限：mount 拉一次，未触摸前用 IPC 值覆盖默认。──
  useEffect(() => {
    invoke<{ concurrency: number }>('get_download_settings')
      .then((s) => {
        if (!concurrencyTouchedRef.current) setConcurrencyInput(String(s.concurrency))
      })
      .catch(() => { /* 无 IPC 保持默认 3 */ })
  }, [])

  // ── Profile 端口表：mount 拉取；失败重试 ≤2 次，每次 800ms。──
  useEffect(() => {
    let cancelled = false
    let attempt = 0
    const load = (): void => {
      invoke<ProfilePortRow[]>('list_profile_ports')
        .then((rows) => {
          if (cancelled) return
          setProfilePorts(rows)
          setProfilePortsStatus({ state: 'ok' })
        })
        .catch((err) => {
          if (cancelled) return
          if (attempt < 2) {
            attempt += 1
            setProfilePortsStatus({ state: 'loading', text: `加载失败，重试中（${attempt}/2）…` })
            window.setTimeout(load, 800)
          } else {
            setProfilePortsStatus({
              state: 'error',
              text: `端口表加载失败：${String(err)}（请重启 dsh 后重试）`,
            })
          }
        })
    }
    load()
    return () => { cancelled = true }
  }, [])

  // ── 运行时目录：mount 拉一次，refreshRuntimes 显式刷新。──
  const refreshRuntimes = useCallback(async (): Promise<void> => {
    setRuntimeStatus({ state: 'loading', text: '读取版本目录中…' })
    try {
      const s = await invoke<RuntimeCatalog>('list_runtime_catalog', { source: runtimeSource })
      setRuntimeCatalog(s)
      setRuntimeStatus(
        s.error
          ? { state: 'error', text: `目录拉取失败：${s.error}（仅显示已下载版本）` }
          : { state: 'ok' },
      )
      setRuntimeDownloading({})
    } catch (err) {
      setRuntimeStatus({ state: 'error', text: `版本目录读取失败：${String(err)}` })
    }
  }, [runtimeSource])

  useEffect(() => {
    void refreshRuntimes()
  }, [refreshRuntimes])

  // ── 迁移进度轮询：migrationRunning=true 时启动；running=false 后自动结束。──
  useEffect(() => {
    if (!migrationRunning) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const st = await invoke<MigrationStatus>('migration_status')
        if (cancelled) return
        if (st.running) {
          setMigrationProgress({ copied: st.copied, total: st.total })
          window.setTimeout(tick, 300)
        } else {
          // 不主动 setMigrationRunning(false)——MIG_RUNNING 在 task_begin 前短暂为 false
          // （需确认覆盖重试窗口），误杀会导致进度条消失（#95 实测）。
          // 继续轮询等 .finally() 清理。
          window.setTimeout(tick, 300)
        }
      } catch {
        /* 单次失败不终止轮询，等下一次 tick */
      }
    }
    void tick()
    return () => { cancelled = true }
  }, [migrationRunning])

  // ── 行为回调 ──
  // ThemeSelect 值回调（非原生事件：曾误用 e.target.value 导致切换无效，#95 实测）
  const handleSourceModeChange = (value: string): void => {
    void nsSave({ dsh_mode: value })
      .then(() => invoke('restart_dsh_service'))
      .then(() =>
        setMsg({ ok: true, text: `dsh 来源已切换为 ${value === 'builtin' ? '内置' : '外部'}，正在重启…` }),
      )
      .catch((err) => {
        console.error('[desktop-settings] set_dsh_source/restart 失败：', err)
        setMsg({ ok: false, text: `切换失败：${String(err)}` })
      })
  }

  const handleSelectRemote = (addr: string | null): void => {
    void (async () => {
      try {
        await nsSave({ remote_addr: addr })
        await invoke('restart_dsh_service')
        setMsg({ ok: true, text: '已切换 dsh 服务来源，正在重启…' })
      } catch (err) {
        setMsg({ ok: false, text: `切换失败：${String(err)}` })
      }
    })()
  }

  const handleAddRemote = (): void => {
    const addr = normalizeRemote(newRemoteUrl)
    if (!addr) {
      setMsg({ ok: false, text: '地址非法：需 dsh web 完整 URL（含 token）或 host[:port]' })
      return
    }
    void (async () => {
      try {
        const list = Array.isArray(desktop.remote_list) ? [...desktop.remote_list] : []
        if (!list.includes(addr)) list.push(addr)
        await nsSave({ remote_list: list })
        setNewRemoteUrl('')
        setMsg({ ok: true, text: `已新增地址：${addr}（未切换，请在下拉框选择）` })
        await refreshData()
      } catch (err) {
        setMsg({ ok: false, text: `新增失败：${String(err)}` })
      }
    })()
  }

  const handleRemoveRemote = (addr: string): void => {
    void (async () => {
      try {
        const list = (desktop.remote_list ?? []).filter((a) => a !== addr)
        const patch: Record<string, unknown> = { remote_list: list }
        if (desktop.remote_addr === addr) patch.remote_addr = null
        await nsSave(patch)
        setMsg({ ok: true, text: `已删除：${addr}` })
      } catch (err) {
        setMsg({ ok: false, text: `删除失败：${String(err)}` })
      }
      await refreshData()
    })()
  }

  const handleSwitchProfile = (name: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      setMsg({ ok: false, text: 'Profile 名不合法' })
      return
    }
    void (async () => {
      try {
        await nsSave({ active_profile: name })
        await invoke('restart_dsh_service')
        setMsg({ ok: true, text: `已切换到 Profile「${name}」，正在重启…` })
      } catch (err) {
        setMsg({ ok: false, text: `切换 Profile 失败：${String(err)}` })
      }
    })()
  }

  const handleSaveProfilePort = (profile: string): void => {
    const raw = profilePortInputs[profile] ?? ''
    const v = Number(raw)
    if (!raw || Number.isNaN(v) || v < 1 || v > 65535) return
    void nsSave({ [`profile_ports.${profile}`]: v })
      .then(() => setProfilePortBoxNote(`${profile} 端口已改为 ${v}；重启该 profile 生效。`))
      .catch((e) => setProfilePortBoxNote(`保存失败：${String(e)}`))
  }

  const handleSavePort = (): void => {
    const port = Number(portDraft)
    if (!portDraft || Number.isNaN(port) || port < 1 || port > 65535) {
      setMsg({ ok: false, text: '请输入 1-65535 的有效端口' })
      return
    }
    void (async () => {
      try {
        await nsSave({ port })
        setPortDraft('')
        setMsg({ ok: true, text: `端口已改为 ${port}；重启 dsh 后生效。` })
      } catch (err) {
        setMsg({ ok: false, text: `设置端口失败：${String(err)}` })
      }
      await refreshData()
    })()
  }

  const handleSaveConcurrency = (): void => {
    const v = Math.max(1, Math.min(32, parseInt(concurrencyInput, 10) || 3))
    void nsSave({ download_concurrency: v })
      .then(() => invoke('set_download_concurrency', { value: v }))
      .then(() => setDownloadBoxNote(`已保存：并发上限 ${v}`))
      .catch(() => setDownloadBoxNote('保存失败（无 Tauri IPC？）'))
  }

  const handleSaveProxy = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        await nsSave({
          proxy_mode: proxy.proxy_mode,
          proxy_url: proxy.proxy_url,
          no_proxy: proxy.no_proxy,
          proxy_user: proxy.proxy_user,
          proxy_pass: proxy.proxy_pass,
        })
        setMsg({ ok: true, text: '代理设置已保存；下次 dsh 重启后生效。' })
      } catch (err) {
        setMsg({ ok: false, text: `保存失败：${String(err)}` })
      } finally {
        setBusy(false)
      }
    })()
  }

  const handleTestProxy = (): void => {
    if (testBusy) return
    setTestBusy(true)
    setTestResult(null)
    void (async () => {
      try {
        const ms = await invoke<number>('test_proxy_connectivity', { url: proxy.proxy_url })
        setTestResult(`连接成功（${ms}ms）`)
      } catch (err) {
        setTestResult(`连接失败：${String(err)}`)
      } finally {
        setTestBusy(false)
      }
    })()
  }

  const handleMigrate = (): void => {
    if (!migrationDest) {
      setMsg({ ok: false, text: '没有可选的目标 profile（请先新建一个）' })
      return
    }
    // 扁平化结构（同 handleDownloadRuntime 模式）：不用 .finally()、不用递归，
    // 每条路径显式管理 migrationRunning。“需确认覆盖”重试不洗 running 状态。
    const start = (overwrite: boolean): void => {
      setMigrationRunning(true)
      setMigrationProgress({ copied: 0, total: 0 })
      invoke<string>('migrate_profile', {
        source: migrationSource,
        dest: migrationDest,
        overwrite,
      })
        .then((s) => {
          setMigrationRunning(false)
          setMigrationProgress(null)
          showToast(s, true)
        })
        .catch((e) => {
          const m = String(e)
          if (!overwrite && m.includes('需确认覆盖')) {
            // 覆盖确认重试：不洗 running，直接发第二次 invoke
            console.error('[migrate] 需确认覆盖，重试 overwrite=true')
            start(true)
            return
          }
          setMigrationRunning(false)
          setMigrationProgress(null)
          console.error('[migrate] 失败：', m)
          showToast(`迁移失败：${m}`, false)
        })
    }
    start(false)
  }

  const handleDownloadRuntime = (version: string): void => {
    setRuntimeDownloading((prev) => ({ ...prev, [version]: 'downloading' }))
    void invoke('download_runtime', { source: runtimeSource, version })
      .then(() => {
        setRuntimeDownloading((prev) => ({ ...prev, [version]: 'downloaded' }))
        void refreshRuntimes()
        showToast(`dsh ${version} 下载完成`, true)
      })
      .catch((err) => {
        // #95 评论：失败原因必须落到 UI，不能只打 console
        const reason = String(err).replace(/^下载失败：?/i, '')
        setRuntimeDownloading((prev) => ({ ...prev, [version]: { failed: reason || '未知错误' } }))
        showToast(`dsh ${version} 下载失败：${reason || '未知错误'}`, false)
      })
  }

  // 下载中轮询 pnpm 进度（remote 页 event.listen 不可用，同 migration_status 模式）
  useEffect(() => {
    const anyDownloading = Object.values(runtimeDownloading).some((s) => s === 'downloading')
    if (!anyDownloading) {
      setDlProgress(null)
      return
    }
    const timer = setInterval(() => {
      void invoke<{
        active: boolean
        version: string
        resolved: number
        downloaded: number
        added: number
        error: string
      }>('runtime_download_status')
        .then((s) => {
          if (s.active) setDlProgress({ version: s.version, resolved: s.resolved, downloaded: s.downloaded, added: s.added })
          else setDlProgress(null)
        })
        .catch(() => {})
    }, 600)
    return () => clearInterval(timer)
  }, [runtimeDownloading])

  const handleSwitchRuntime = (version: string): void => {
    // 运行时切换 = 内置树换版本：必须同时钉回 builtin（否则 mode=external 时切了也仍走外部 CLI）
    // #113：内置版本 = 回内置兜底 → dsh_runtime 置 null（存版本号会让顶部误显示「当前使用：运行时 xxx」）
    const isBuiltin = runtimeCatalog?.builtin === version
    void nsSave({ dsh_runtime: isBuiltin ? null : version, dsh_mode: 'builtin' })
      .then(() => invoke('restart_dsh_service'))
      .then(() => {
        setMsg({ ok: true, text: `已切换到 dsh ${version}，正在重启…` })
        void refreshRuntimes()
      })
      .catch((err) => setMsg({ ok: false, text: `切换失败：${String(err)}` }))
  }

  const handleRemoveRuntime = (version: string): void => {
    // #104/#110：卸载已下载运行时，后端 async+spawn_blocking（不阻塞 UI）；错误文案可观测。
    if (removingVersion) return
    if (!window.confirm(`卸载运行时 dsh ${version}？将删除本地已下载文件，不可恢复。`)) return
    setRemovingVersion(version)
    invoke('remove_runtime', { version })
      .then(() => {
        setMsg({ ok: true, text: `已卸载运行时 dsh ${version}` })
        void refreshRuntimes()
      })
      .catch((err) => setMsg({ ok: false, text: `卸载失败：${String(err)}` }))
      .finally(() => setRemovingVersion(null))
  }

  const refreshData = useCallback(async (): Promise<void> => {
    try {
      const d = await invoke<DesktopData>('get_desktop_settings_data')
      setDesktop(d)
    } catch {
      /* 保留旧数据 */
    }
  }, [])

  // ── 派生展示 ──
  const sourceModeValue: string = sourceState
    ? sourceState.running
      ? sourceState.running.mode
      : sourceState.mode
    : 'builtin'

  const sourceInfoText = ((): string => {
    if (!sourceState) return ''
    const parts: string[] = []
    if (sourceState.running) {
      const runVer =
        sourceState.running.version ||
        (sourceState.running.mode === 'builtin'
          ? (sourceState.builtin?.dsh_version ?? '')
          : (sourceState.external?.dsh_version ?? ''))
      const origin = sourceState.running.origin === 'shell' ? '本壳 spawn' : '复用接入'
      parts.push(
        `当前运行：${sourceState.running.mode === 'builtin' ? '内置' : '外部'} dsh ${runVer}（${origin} · port ${sourceState.running.port}）`,
      )
    } else {
      parts.push('当前无运行中的 dsh 实例；下次启动将使用下方所选来源')
    }
    if (sourceState.builtin) parts.push(`内置可用：dsh ${sourceState.builtin.dsh_version}`)
    if (sourceState.external) parts.push(`外部可用：dsh ${sourceState.external.dsh_version}（${sourceState.external.path}）`)
    return parts.join(' · ')
  })()

  // 迁移 select 选项：源 = 全 profile；目标 = 排除源后的其余 profile（原 fillDst 行为）。
  const migrationDestOptions = desktop.profiles.filter((p) => p.name !== migrationSource)

  // Profile select 选中（active 优先；与原代码 `if (p.active) o.selected = true` 等价）。
  const activeProfile = desktop.profiles.find((p) => p.active)
  const profileSelectValue = activeProfile?.name ?? desktop.profiles[0]?.name ?? ''

  // ── 渲染 ──
  return (
    <div data-desktop-settings="" style={ROOT_STYLE}>
        {taskInfo && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              marginBottom: 10,
              fontSize: 12,
              background: 'var(--dsw-alias-bg-base,#16181d)',
              border: taskInfo.finished
                ? taskInfo.error
                  ? '1px solid rgba(239,68,68,.6)'
                  : '1px solid rgba(34,197,94,.5)'
                : '1px solid var(--dsw-alias-border-neutral,#2a2e37)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {taskInfo.running ? '⏳ ' : taskInfo.error ? '✗ ' : '✓ '}
              {taskInfo.title}
            </div>
            {taskInfo.running && (
              <>
                <div style={{ opacity: 0.8 }}>{taskInfo.stage || '准备中…'}</div>
                {taskInfo.total > 0 && (
                  <>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 3,
                        marginTop: 6,
                        overflow: 'hidden',
                        background: 'rgba(127,127,127,.25)',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, Math.round((taskInfo.done / taskInfo.total) * 100))}%`,
                          background: 'var(--dsw-alias-state-accent-primary,#3b82f6)',
                          transition: 'width .3s',
                        }}
                      />
                    </div>
                    <div style={{ opacity: 0.6, marginTop: 3 }}>
                      {taskInfo.done}/{taskInfo.total}
                    </div>
                  </>
                )}
              </>
            )}
            {taskInfo.finished && taskInfo.error && (
              <div style={{ color: '#f87171', whiteSpace: 'pre-wrap' }}>{taskInfo.error}</div>
            )}
            {taskInfo.finished && !taskInfo.error && taskInfo.result && (
              <div style={{ opacity: 0.85 }}>{taskInfo.result}</div>
            )}
          </div>
        )}
      {/* ── dsh 来源（#90，置顶：切换内置/外部）── */}
      <SectionBox title="dsh 来源（内置 / 外部）">
        <ThemeSelect
          style={{ marginBottom: 8 }}
          value={sourceModeValue}
          onChange={handleSourceModeChange}
          options={[
            { value: 'builtin', label: '内置（随应用分发，推荐）' },
            { value: 'external', label: '外部（DSH_BIN → PATH → npm 全局）' },
          ]}
        />
        {sourceState ? (
          <div style={NOTE_STYLE}>{sourceInfoText}</div>
        ) : sourceError ? (
          <div style={DANGER_NOTE_STYLE}>检测失败：{sourceError}</div>
        ) : (
          <div style={NOTE_STYLE}>检测中…</div>
        )}
        <div style={{ marginTop: 8 }}>
          <PfBtn variant="ghost" onClick={() => void refreshSource()}>重新检测</PfBtn>
        </div>
        <div style={NOTE_STYLE}>
          内置：随应用分发的 dsh 依赖树 + Node，直调内部启动接口（不依赖系统环境）。外部：使用系统安装的 dsh CLI。切换后立即重启 dsh。
        </div>
      </SectionBox>

      {/* ── dsh 服务地址 ── */}
      <SectionBox title="dsh 服务地址">
        <ThemeSelect
          style={{ marginBottom: 8 }}
          value={desktop.remote_addr ?? ''}
          onChange={(v) => handleSelectRemote(v || null)}
          options={[
            { value: '', label: '本地（127.0.0.1）' },
            ...(desktop.remote_list ?? []).map((addr) => ({ value: addr, label: addr })),
          ]}
        />

        {/* 新增地址行 */}
        <div style={ROW_STYLE}>
          <input
            placeholder="新增：dsh web 打印的完整 URL（含 token）或 host[:port]"
            className="pf-input"
            style={FLEX_1_STYLE}
            data-desktop-settings="remote-add"
            value={newRemoteUrl}
            onChange={(e) => setNewRemoteUrl(e.target.value.trim())}
          />
          <PfBtn variant="ghost" onClick={handleAddRemote}>新增</PfBtn>
        </div>

        {/* 地址删除行 */}
        {desktop.remote_list.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {desktop.remote_list.map((addr) => (
              <PfBtn
                key={addr}
                variant="danger"
                style={{ fontSize: 11 }}
                onClick={() => handleRemoveRemote(addr)}
              >
                删除：{addr}
              </PfBtn>
            ))}
          </div>
        )}
        <div style={NOTE_STYLE}>
          选择远程地址后立即按当前模式重启 dsh；新增/删除仅改列表，重启后生效。
        </div>
      </SectionBox>

      {/* ── Profile ── */}
      <SectionBox title="Profile">
        <ThemeSelect
          style={{ marginBottom: 8 }}
          value={profileSelectValue}
          onChange={handleSwitchProfile}
          options={(desktop.profiles ?? []).map((p) => ({
            value: p.name,
            label: p.active ? `✓ ${p.name}` : p.name,
          }))}
        />
        <div style={NOTE_STYLE}>切换 Profile 会以目标 profile 重启 dsh web。</div>
      </SectionBox>

      {/* ── Profile 端口（#90）── */}
      <SectionBox title="Profile 端口">
        {profilePortsStatus.state === 'ok' ? (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Profile', '启动端口', 'Lane 端口', '状态', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profilePorts.map((r) => (
                <tr key={r.profile}>
                  <td>{r.profile}</td>
                  <td>
                    <input
                      placeholder={String(r.port)}
                      style={{ ...INPUT_BASE_STYLE, width: 84 }}
                      data-desktop-settings={`profile-port-${r.profile}`}
                      value={profilePortInputs[r.profile] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        setProfilePortInputs((prev) => ({ ...prev, [r.profile]: v }))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveProfilePort(r.profile)
                      }}
                    />
                    <PfBtn
                      variant="ghost"
                      style={{ marginLeft: 6 }}
                      onClick={() => handleSaveProfilePort(r.profile)}
                    >
                      保存
                    </PfBtn>
                  </td>
                  <td>{r.lane_port}</td>
                  <td
                    style={{
                      color: r.running
                        ? 'var(--dsw-alias-state-success-primary,#2fbf71)'
                        : 'var(--dsw-alias-label-secondary,#9aa4b2)',
                    }}
                  >
                    {r.running ? '● 运行中' : '未运行'}
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        ) : profilePortsStatus.state === 'error' ? (
          <div style={DANGER_NOTE_STYLE}>{profilePortsStatus.text}</div>
        ) : (
          <div style={NOTE_STYLE}>{profilePortsStatus.text ?? '加载中…'}</div>
        )}
        {profilePortBoxNote && <div style={NOTE_STYLE}>{profilePortBoxNote}</div>}
        <div style={NOTE_STYLE}>
          web 固定默认 3080 · desktop 固定默认 3081 · 其余自动分配；lane 同规则错开（3092 起）。改动后重启该 profile 生效。
        </div>
      </SectionBox>

      {/* ── 迁移 Profile（#88/#90）── */}
      <SectionBox title="迁移 Profile">
        <div style={LABEL_STYLE}>源 profile → 目标 profile（全量复制；目标已存在需覆盖确认）</div>
        <div style={ROW_STYLE}>
          <ThemeSelect
            style={{ flex: 1 }}
            value={migrationSource}
            onChange={(v) => {
              setMigrationSource(v)
              const others = desktop.profiles.filter((p) => p.name !== v)
              const nextDest = others.find((p) => p.name === migrationDest) ?? others[0]
              if (nextDest) setMigrationDest(nextDest.name)
              else setMigrationDest('')
            }}
            options={(desktop.profiles ?? []).map((p) => ({ value: p.name, label: p.name }))}
          />
          <ThemeSelect
            style={{ flex: 1 }}
            value={migrationDest}
            onChange={(v) => setMigrationDest(v)}
            options={migrationDestOptions.map((p) => ({ value: p.name, label: p.name }))}
          />
          <PfBtn variant="ghost" onClick={handleMigrate}>迁移…</PfBtn>
        </div>

        {migrationRunning && (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                height: 6,
                borderRadius: 4,
                background: 'var(--dsw-alias-bg-base,#111)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width:
                    migrationProgress && migrationProgress.total > 0
                      ? `${Math.min(100, Math.round((migrationProgress.copied / migrationProgress.total) * 100))}%`
                      : '0%',
                  background: 'var(--dsw-alias-state-accent-primary,#3b82f6)',
                  transition: 'width .2s',
                }}
              />
            </div>
            <div style={NOTE_STYLE}>
              {migrationProgress
                ? `迁移中：${migrationProgress.copied}/${migrationProgress.total} 个文件（${
                    migrationProgress.total > 0
                      ? Math.min(100, Math.round((migrationProgress.copied / migrationProgress.total) * 100))
                      : 0
                  }%）`
                : '准备中…'}
            </div>
          </div>
        )}

        <div style={NOTE_STYLE}>
          迁移为当前时点快照：不停止、不重启任何运行中的服务；源在迁移期间的新数据不包含在副本内。目标为激活 profile 时拒绝迁移。
        </div>
      </SectionBox>

      {/* ── dsh 运行时（版本管理：下载/切换，#95）── */}
      <SectionBox title="dsh 运行时（版本下载 / 切换）">
        <ThemeSelect
          style={{ marginBottom: 8 }}
          value={runtimeSource}
          onChange={(v) => setRuntimeSource(v as 'github' | 'npm')}
          options={[
            { value: 'github', label: '下载源：GitHub Releases' },
            { value: 'npm', label: '下载源：npm registry' },
          ]}
        />
        <PfBtn variant="ghost" onClick={() => void refreshRuntimes()}>刷新版本目录</PfBtn>
        <div style={{ marginTop: 8 }}>
          {runtimeStatus.state === 'error' && runtimeStatus.text && (
            <div style={DANGER_NOTE_STYLE}>{runtimeStatus.text}</div>
          )}
          {runtimeCatalog && (
            <>
              <div style={{ marginBottom: 6 }}>
                {runtimeCatalog.selected
                  ? `当前使用：运行时 ${runtimeCatalog.selected}${
                      runtimeCatalog.builtin ? '（内置兜底 ' + runtimeCatalog.builtin + '）' : ''
                    }`
                  : runtimeCatalog.builtin
                    ? `当前使用：内置 dsh ${runtimeCatalog.builtin}（兜底）`
                    : '当前无可用 dsh'}
              </div>
              {(() => {
                // 折叠（#95）：默认只显示各渠道头版 + 已下载版本，其余收进「展开全部」
                const seen = new Set<string>()
                const heads: typeof runtimeCatalog.catalog = []
                for (const ch of ['latest', 'alpha', 'rc']) {
                  const e = runtimeCatalog.catalog.find((c) => c.channel === ch)
                  if (e && !seen.has(e.version)) {
                    seen.add(e.version)
                    heads.push(e)
                  }
                }
                const installedPinned = runtimeCatalog.catalog.filter(
                  (c) =>
                    !seen.has(c.version) &&
                    runtimeCatalog.installed.some((i) => i.version === c.version),
                )
                const rest = runtimeCatalog.catalog.filter((c) => !seen.has(c.version))
                // #107 并集渲染：installed 中不在 catalog 的版本（目录拉取失败/版本已下架）也要可见
                const installedOnly = runtimeCatalog.installed
                  .filter((i) => !runtimeCatalog.catalog.some((c) => c.version === i.version))
                  .map((i) => ({ version: i.version, channel: '' }))
                // 补：内置版本同样可能不在 catalog（目录拉取失败时）——必须可见以切回内置
                if (
                  runtimeCatalog.builtin &&
                  !runtimeCatalog.catalog.some((c) => c.version === runtimeCatalog.builtin) &&
                  !installedOnly.some((i) => i.version === runtimeCatalog.builtin)
                ) {
                  installedOnly.unshift({ version: runtimeCatalog.builtin, channel: '' })
                }
                const visible = runtimeExpanded
                  ? [...runtimeCatalog.catalog, ...installedOnly]
                  : [...heads, ...installedPinned, ...installedOnly.filter((i) => !seen.has(i.version))]
                return (
                  <>
                    {visible.map((c) => {
                      const installed = runtimeCatalog.installed.some((i) => i.version === c.version)
                      // #113：内置随包分发（不在 installed 数组）——可切换、标「内置」、不显示下载
                      const isBuiltin = runtimeCatalog.builtin === c.version
                      const available = installed || isBuiltin
                      // 当前使用：selected 有值按号匹配；selected 为空 = 内置兜底（内置行即「使用中」）
                      const isCurrent = runtimeCatalog.selected
                        ? runtimeCatalog.selected === c.version
                        : isBuiltin
                      const tags: string[] = []
                      if (c.channel) tags.push(c.channel)
                      if (isBuiltin) tags.push('内置')
                      else if (installed) tags.push('已下载')
                      const downloadState = runtimeDownloading[c.version]
                      const failedReason = typeof downloadState === 'object' ? downloadState.failed : ''
                      const pct =
                        dlProgress && dlProgress.version === c.version && dlProgress.resolved > 0
                          ? Math.min(100, Math.round((dlProgress.downloaded / dlProgress.resolved) * 100))
                          : 0
                      return (
                        <div key={c.version} style={{ margin: '4px 0' }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <span>{`${c.version}${tags.length ? '（' + tags.join(' · ') + '）' : ''}`}</span>
                            {!available ? (
                              <PfBtn
                                variant="ghost"
                                disabled={downloadState === 'downloading'}
                                onClick={() => handleDownloadRuntime(c.version)}
                              >
                                {downloadState === 'downloading'
                                  ? '下载中…'
                                  : failedReason
                                    ? '重试下载'
                                    : downloadState === 'downloaded'
                                      ? '已下载'
                                      : '下载'}
                              </PfBtn>
                            ) : (
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <PfBtn
                                  variant="ghost"
                                  disabled={isCurrent}
                                  onClick={() => handleSwitchRuntime(c.version)}
                                >
                                  {isCurrent ? '使用中' : '切换到此版本'}
                                </PfBtn>
                                <PfBtn
                                  variant="danger"
                                  disabled={removingVersion !== null || runtimeCatalog.selected === c.version || c.version === runtimeCatalog.builtin}
                                  title={
                                    runtimeCatalog.selected === c.version
                                      ? '使用中的版本不可卸载，请先切换'
                                      : c.version === runtimeCatalog.builtin
                                        ? '内置版本随应用分发，不可卸载'
                                        : '删除本地已下载的运行时'
                                  }
                                  onClick={() => handleRemoveRuntime(c.version)}
                                >
                                  {removingVersion === c.version ? '卸载中…' : '卸载'}
                                </PfBtn>
                              </div>
                            )}
                          </div>
                          {downloadState === 'downloading' && (
                            <div style={{ marginTop: 4 }}>
                              <div
                                style={{
                                  height: 6,
                                  borderRadius: 4,
                                  background: 'var(--dsw-alias-bg-base,#111)',
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  style={{
                                    height: '100%',
                                    width: `${pct}%`,
                                    background: 'var(--dsw-alias-state-accent-primary,#3b82f6)',
                                    transition: 'width .3s',
                                  }}
                                />
                              </div>
                              <div style={NOTE_STYLE}>
                                {dlProgress && dlProgress.version === c.version
                                  ? `安装依赖：已下载 ${dlProgress.downloaded} / ${dlProgress.resolved || '…'} 个包${
                                      dlProgress.resolved > 0 ? `（${pct}%）` : ''
                                    }`
                                  : '准备中…'}
                              </div>
                            </div>
                          )}
                          {failedReason && (
                            <div style={{ ...DANGER_NOTE_STYLE, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              下载失败：{failedReason}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {rest.length > 0 && !runtimeExpanded && (
                      <PfBtn variant="ghost" style={{ marginTop: 4 }} onClick={() => setRuntimeExpanded(true)}>
                        展开全部 {runtimeCatalog.catalog.length} 个版本 ▾
                      </PfBtn>
                    )}
                    {runtimeExpanded && (
                      <PfBtn variant="ghost" style={{ marginTop: 4 }} onClick={() => setRuntimeExpanded(false)}>
                        收起版本列表 ▴
                      </PfBtn>
                    )}
                  </>
                )
              })()}
              </>
          )}
        </div>
      </SectionBox>

      {/* ── 本地端口 ── */}
      <SectionBox title="本地端口">
        <div style={ROW_STYLE}>
          <input
            placeholder={`当前 ${desktop.port}`}
            style={{ ...INPUT_BASE_STYLE, width: 140 }}
            data-desktop-settings="port"
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value.trim())}
          />
          <PfBtn variant="ghost" onClick={handleSavePort}>保存端口</PfBtn>
        </div>
        <div style={NOTE_STYLE}>改动后需重启 dsh 生效（可用托盘「重启 dsh 服务」）。</div>
      </SectionBox>

      {/* ── 下载（#72）── */}
      <SectionBox title="下载">
        <div style={ROW_STYLE}>
          <input
            placeholder="1-32"
            data-desktop-settings="download-concurrency"
            style={{ ...INPUT_BASE_STYLE, width: 80 }}
            value={concurrencyInput}
            onChange={(e) => {
              concurrencyTouchedRef.current = true
              setConcurrencyInput(e.target.value)
            }}
          />
          <PfBtn variant="ghost" onClick={handleSaveConcurrency}>保存</PfBtn>
        </div>
        {downloadBoxNote && <div style={NOTE_STYLE}>{downloadBoxNote}</div>}
        <div style={NOTE_STYLE}>同时进行的下载数上限，超出排队；改动立即生效。</div>
      </SectionBox>

      {/* ── 代理设置 ── */}
      <SectionBox title="代理设置">
        <div style={LABEL_STYLE}>代理模式</div>
        <ThemeSelect
          style={{ marginBottom: 10 }}
          value={proxy.proxy_mode}
          onChange={(v) => setProxy({ ...proxy, proxy_mode: v })}
          options={[
            { value: 'off', label: '不使用代理' },
            { value: 'system', label: '跟随系统代理' },
            { value: 'manual', label: '手动指定代理' },
          ]}
        />

        {proxy.proxy_mode === 'manual' && (
          <>
            <div style={LABEL_STYLE}>代理 URL</div>
            <input
              placeholder="http/https/socks5://host:port"
              value={proxy.proxy_url}
              className="pf-input"
              style={INPUT_FULL_STYLE}
              data-desktop-settings="proxy-url"
              onChange={(e) => setProxy({ ...proxy, proxy_url: e.target.value.trim() })}
            />
          </>
        )}

        {/* #102：NO_PROXY 为 manual 专属（system 模式下后端读系统设置，编辑不生效）；凭证两种模式都生效（拼入代理 URL） */}
        {(proxy.proxy_mode === 'manual' || proxy.proxy_mode === 'system') && (
          <>
        {proxy.proxy_mode === 'manual' && (
          <>
            <div style={LABEL_STYLE}>NO_PROXY（不走代理的地址，逗号分隔）</div>
            <input
              placeholder="localhost,127.0.0.1,*.internal"
              value={proxy.no_proxy}
              className="pf-input"
              style={INPUT_FULL_STYLE}
              data-desktop-settings="no-proxy"
              onChange={(e) => setProxy({ ...proxy, no_proxy: e.target.value.trim() })}
            />
          </>
        )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <div style={FLEX_1_STYLE}>
                <div style={LABEL_STYLE}>用户名（可选）</div>
                <input
                  value={proxy.proxy_user}
                  className="pf-input"
                  style={INPUT_FULL_STYLE}
                  data-desktop-settings="proxy-user"
                  onChange={(e) => setProxy({ ...proxy, proxy_user: e.target.value })}
                />
              </div>
              <div style={FLEX_1_STYLE}>
                <div style={LABEL_STYLE}>密码（可选）</div>
                <input
                  type="password"
                  value={proxy.proxy_pass}
                  className="pf-input"
                  style={INPUT_FULL_STYLE}
                  data-desktop-settings="proxy-pass"
                  onChange={(e) => setProxy({ ...proxy, proxy_pass: e.target.value })}
                />
              </div>
            </div>
          </>
        )}

        {proxyEffective && (
          <div style={NOTE_STYLE}>当前生效：{JSON.stringify(proxyEffective)}</div>
        )}
        {proxy.proxy_mode === 'system' && (
          <div style={NOTE_STYLE}>系统代理模式下，代理地址与 NO_PROXY 来自系统设置（如 Windows 注册表 ProxyOverride）；用户名/密码仍取自设置并拼入代理地址。</div>
        )}

        {proxy.proxy_mode === 'manual' && proxy.proxy_url && (
          <>
            <div style={{ marginTop: 8 }}>
              <PfBtn variant="ghost" onClick={handleTestProxy}>
                {testBusy ? '测试中…' : '测试连接'}
              </PfBtn>
            </div>
            {testResult && <div style={NOTE_STYLE}>{testResult}</div>}
          </>
        )}
      </SectionBox>

      {/* ── 保存（代理）── */}
      <div>
        <PfBtn variant="primary" disabled={busy} onClick={handleSaveProxy}>
          {busy ? '保存中…' : '保存代理设置'}
        </PfBtn>
      </div>

      {msg && (
        <div
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 99999,
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            maxWidth: 480,
            boxShadow: '0 4px 12px rgba(0,0,0,.4)',
            cursor: 'pointer',
            background: msg.ok ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)',
            border: `1px solid ${msg.ok ? 'rgba(34,197,94,.6)' : 'rgba(239,68,68,.6)'}`,
            color: msg.ok ? '#4ade80' : '#f87171',
            backdropFilter: 'blur(8px)',
          }}
          onClick={() => setMsg(null)}
        >
          {msg.text}
        </div>
      )}

      <div style={NOTE_STYLE}>
        服务地址/Profile 切换会立即重启 dsh；端口与代理在下次重启后生效。
      </div>
    </div>
  )
}

export function registerDesktopSettings(ctx: ClientContext): void {
  if (!hasIpc()) return
  // 捕获 connection RPC（dsh settings 服务的桌面壳命名空间读写通道）
  try {
    nsRpc =
      (ctx as unknown as { connection?: NsRpc }).connection ?? null
  } catch {
    nsRpc = null
  }
  const slots = (ctx as unknown as {
    slots?: {
      inject: (name: string, fn: () => void) => void
      register: (meta: Record<string, unknown>, comp: unknown) => void
    }
  }).slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'dsh-desktop-settings', order: 40, label: () => '桌面设置' },
      DesktopSettingsPanel,
    ),
  )

  // dsh 启动后：取回启动时选择的 profile，通过 nsSave 持久化到 settings.yaml
  void invoke<string | null>('get_pending_active_profile').then((profile) => {
    if (profile && nsRpc) {
      void nsSave({ active_profile: profile }).catch(() => {})
    }
  }).catch(() => {})

  // 启动检查：前端加载后调 check_startup_needed，根据返回显示弹窗
  void invoke<{ action: string; profiles?: string[]; profile?: string; details?: { dir_exists: boolean; missing_files: string[]; node_modules_exists: boolean } }>('check_startup_needed').then((res) => {
    if (!res || res.action === 'none') return
    if (res.action === 'profile-selection') {
      const profiles = res.profiles ?? []
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)'
      const card = document.createElement('div')
      card.style.cssText = 'background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:24px;min-width:320px;max-width:400px'
      const title = document.createElement('div')
      title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:16px;color:var(--dsw-alias-label-primary,#e7eaf0)'
      title.textContent = '选择要启动的 Profile'
      card.appendChild(title)
      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-direction:column;gap:8px'
      for (const p of profiles) {
        const btn = document.createElement('button')
        btn.style.cssText = 'padding:10px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer;text-align:left'
        btn.textContent = p
        btn.onmouseenter = () => btn.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))'
        btn.onmouseleave = () => btn.style.background = 'transparent'
        btn.onclick = () => {
          el.remove()
          showToast(`正在启动 ${p} profile…`, true)
          void invoke('confirm_startup_profile', { name: p, repair: false }).catch((e) => showToast(`启动失败：${String(e)}`, false))
        }
        list.appendChild(btn)
      }
      const input = document.createElement('input')
      input.style.cssText = 'margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;width:100%;box-sizing:border-box'
      input.placeholder = '或输入新 profile 名称'
      const startBtn = document.createElement('button')
      startBtn.style.cssText = 'margin-top:8px;padding:8px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer;width:100%'
      startBtn.textContent = '新建并启动'
      startBtn.onclick = () => {
        const name = input.value.trim()
        if (!name) return
        el.remove()
        showToast(`正在创建并启动 ${name} profile…`, true)
        void invoke('confirm_startup_profile', { name, repair: true }).catch((e) => showToast(`创建失败：${String(e)}`, false))
      }
      card.appendChild(list)
      card.appendChild(input)
      card.appendChild(startBtn)
      el.appendChild(card)
      document.body.appendChild(el)
      return
    }
    if (res.action === 'profile-incomplete') {
      const profile = res.profile ?? ''
      if (!profile) return
      const details = res.details
      const missingDesc = details ? [
        ...details.missing_files,
        ...(details.node_modules_exists ? [] : ['node_modules']),
        ...(details.dir_exists ? [] : ['profile 目录']),
      ].join(', ') : ''
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)'
      const card = document.createElement('div')
      card.style.cssText = 'background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:24px;min-width:340px;max-width:420px;text-align:center'
      const title = document.createElement('div')
      title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary,#e7eaf0)'
      title.textContent = `Profile「${profile}」不完整`
      const desc = document.createElement('div')
      desc.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:20px'
      desc.textContent = `缺失：${missingDesc}。是否修复？`
      const btns = document.createElement('div')
      btns.style.cssText = 'display:flex;gap:10px'
      const noBtn = document.createElement('button')
      noBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer'
      noBtn.textContent = '直接启动'
      noBtn.onclick = () => {
        el.remove()
        void invoke('confirm_startup_profile', { name: profile, repair: false }).catch((e) => showToast(`启动失败：${String(e)}`, false))
      }
      const yesBtn = document.createElement('button')
      yesBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer'
      yesBtn.textContent = '修复并启动'
      yesBtn.onclick = () => {
        el.remove()
        showToast(`正在修复 ${profile} profile…`, true)
        void invoke('confirm_startup_profile', { name: profile, repair: true }).catch((e) => showToast(`修复失败：${String(e)}`, false))
      }
      btns.appendChild(noBtn)
      btns.appendChild(yesBtn)
      card.appendChild(title)
      card.appendChild(desc)
      card.appendChild(btns)
      el.appendChild(card)
      document.body.appendChild(el)
    }
  }).catch(() => {})
}
