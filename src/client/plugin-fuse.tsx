// 插件保险丝设置面板（#59，布局按 #55 定稿：变体 A 分栏主从）。
// 通过 settings.section 槽位注册（与 dsh-mobile-access 同一契约）；
// 数据经 Tauri IPC 与 Rust 后端通信；纯浏览器（无 IPC）不注册。
// 主题只用 --dsw-alias-* 变量（带回退值），禁止 hash 类名（仓库血泪坑 #8）。
// 重写自混合 DOM 写法（buildPanel + document.createElement）：纯 React JSX + hooks，
// 状态全部 useState/useEffect/useCallback 声明式管理；保留注册契约与全部交互行为。
import type { ClientContext } from './ctx-types.ts'
import React from 'react'

export const inject = ['slots']

/** Tauri IPC 可用性（桌面壳 webview 才有；纯浏览器无）。 */
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

// ── 数据契约 ────────────────────────────────────────────────────────────

interface QuarantineEntry {
  id: string
  name: string
  reason: string
  failure_type: string
  raw_error: string
  quarantined_at: string
  file: string
  repairable: boolean
}

interface ListQuarantineResp {
  profile: string
  entries: QuarantineEntry[]
}

interface DoctorCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

interface FuseSettings {
  first_party_protection: boolean
  exclude: string[]
  max_retries: number
  ai_provider: string
  ai_model: string
  ai_base_url: string
  ai_key_env: string
}

interface ProviderEntry {
  id: string
  name: string
  settingsNs: string
  models: Array<{ id: string; name?: string }>
}

type ProviderDirState = null | 'loading' | { error: string } | ProviderEntry[]
type DoctorState = null | 'idle' | 'running' | DoctorCheck[]
type ExplainMap = Record<string, null | 'loading' | string>

const TYPE_LABEL: Record<string, string> = {
  'load-list': '加载失败',
  activation: '激活失败',
  'loader-entry': 'loader entry',
  'stack-id': '外层栈',
  'duplicate-id': '重复挂载',
  'patch-parse': 'patch 解析失败',
}

const DEFAULT_SETTINGS: FuseSettings = {
  first_party_protection: true,
  exclude: [],
  max_retries: 2,
  ai_provider: 'deepseek',
  ai_model: '',
  ai_base_url: '',
  ai_key_env: '',
}

const RETRIES_MIN = 0
const RETRIES_MAX = 5

// ── 注册契约 ────────────────────────────────────────────────────────────

let fuseConnection: { rpc: { call: (channel: string, endpoint: string, payload?: unknown) => Promise<any> } } | null = null

/** 注册 settings.section「插件保险丝」。 */
export function registerFusePanel(ctx: ClientContext): void {
  if (!hasIpc()) {
    ctx?.logger?.warn?.('plugin-fuse: 无 Tauri IPC（纯浏览器），跳过设置入口')
    return
  }
  fuseConnection = (ctx as unknown as { connection?: typeof fuseConnection }).connection ?? null
  const slots = (ctx as unknown as {
    slots?: {
      inject: (name: string, fn: () => void) => void
      register: (meta: Record<string, unknown>, comp: unknown) => void
    }
  }).slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    ctx?.logger?.warn?.('plugin-fuse: slots 服务不可用，跳过设置入口')
    return
  }
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'dsh-plugin-fuse',
        order: 30,
        label: () => '插件保险丝',
      },
      FusePanelSafe,
    ),
  )
}

// ── 样式（伪类 hover/active 必须用真样式表） ─────────────────────────────

function usePanelStyles(): void {
  React.useEffect(() => {
    if (document.querySelector('style[data-plugin-fuse-styles]')) return
    const style = document.createElement('style')
    style.dataset.pluginFuseStyles = '1'
    style.textContent = `
[data-plugin-fuse] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s, background .12s; }
[data-plugin-fuse] .pf-btn:hover { filter:brightness(1.12); }
[data-plugin-fuse] .pf-btn:active { transform:translateY(1px); filter:brightness(.95); }
[data-plugin-fuse] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-plugin-fuse] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-plugin-fuse] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-plugin-fuse] .pf-btn.danger { background:transparent; border:1px solid var(--dsw-alias-state-danger-primary,#e5534b); color:var(--dsw-alias-state-danger-primary,#e5534b); }
[data-plugin-fuse] .pf-btn.danger:hover { background:rgba(229,83,75,.12); filter:none; }
[data-plugin-fuse] .pf-btn.danger:active { transform:translateY(1px); background:rgba(229,83,75,.2); filter:none; }
[data-plugin-fuse] .pf-btn.sm { padding:2px 8px; font-size:11px; border-radius:6px; }
[data-plugin-fuse] .pf-row { transition:background .12s; cursor:pointer; }
[data-plugin-fuse] .pf-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06)); }
[data-plugin-fuse] .pf-chip { transition:background .12s; border-radius:6px; cursor:pointer; }
[data-plugin-fuse] .pf-chip:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); }
[data-plugin-fuse] .pf-select { width:100%; padding:6px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l,#ffffff1f); background:var(--dsw-alias-bg-base,#151517); color:inherit; font-size:12px; box-sizing:border-box; }
[data-plugin-fuse] .pf-toggle { position:relative; width:34px; height:19px; border-radius:999px; cursor:pointer; flex:none; }
[data-plugin-fuse] .pf-toggle.on { background:var(--dsw-alias-state-success-primary,#2fbf71); }
[data-plugin-fuse] .pf-toggle.off { background:var(--dsw-alias-border-l,#ffffff1f); }
[data-plugin-fuse] .pf-toggle .knob { position:absolute; top:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:left .12s; }
[data-plugin-fuse] .pf-toggle.on .knob { left:17px; }
[data-plugin-fuse] .pf-toggle.off .knob { left:2px; }
[data-plugin-fuse] .pf-raw { cursor:pointer; transition:max-height .12s; }
`
    document.head.appendChild(style)
  }, [])
}

// ── 顶层组件 ────────────────────────────────────────────────────────────
/** 面板错误边界（#59 收尾）：面板内任何渲染异常不再让整个设置区空白——
 *  面板内显示可读错误，并把详情写进应用日志（webview console 镜像 → dsh-desktop-webview.log）。 */
class FuseErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const detail = `${String(error?.message ?? '')} | ${String(info?.componentStack ?? '')}`
    console.error('[plugin-fuse] 面板渲染异常：', detail)
    try {
      void invoke('log_diag', { msg: `[plugin-fuse] 面板渲染异常：${detail}` })
    } catch {
      /* 日志通道不可用时忽略 */
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div data-plugin-fuse="1" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          <div style={{ color: 'var(--dsw-alias-state-danger-primary,#e5534b)' }}>
            插件保险丝面板渲染失败：{String(this.state.error.message ?? this.state.error)}
          </div>
          <div style={{ color: 'var(--dsw-alias-label-secondary,#9aa4b2)', marginTop: 4 }}>
            详情已写入应用日志（~/.dsh/dsh-desktop-webview.log）
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/** 注册用包装（错误边界 + FusePanel；名字独立便于日志辨认）。 */
function FusePanelSafe(): React.ReactElement {
  return (
    <FuseErrorBoundary>
      <FusePanel />
    </FuseErrorBoundary>
  )
}


function FusePanel(): React.ReactElement {
  usePanelStyles()

  // ── state ──
  const [entries, setEntries] = React.useState<QuarantineEntry[]>([])
  const [profile, setProfile] = React.useState<string>('web')
  const [selected, setSelected] = React.useState<number>(0)
  const [doctor, setDoctor] = React.useState<DoctorState>(null)
  const [doctorError, setDoctorError] = React.useState<string | null>(null)
  const [explain, setExplain] = React.useState<ExplainMap>({})
  const [settings, setSettings] = React.useState<FuseSettings | null>(null)
  const [showSettings, setShowSettings] = React.useState<boolean>(false)
  const [showRaw, setShowRaw] = React.useState<boolean>(true)
  const [repairBusy, setRepairBusy] = React.useState<string | null>(null)
  const [providerDir, setProviderDir] = React.useState<ProviderDirState>(null)
  const [repairMsg, setRepairMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [summaryText, setSummaryText] = React.useState<string>('')
  const [noticeMsg, setNoticeMsg] = React.useState<string | null>(null)

  // 选中索引随列表长度自适应（删除/恢复后索引可能越界）
  const safeSelected = Math.min(selected, Math.max(entries.length - 1, 0))
  const currentEntry = entries[safeSelected]

  // ── 数据加载 ──

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const resp = await invoke<ListQuarantineResp>('list_quarantine')
      setProfile(resp.profile)
      setEntries(resp.entries)
    } catch (err) {
      console.error('[plugin-fuse] list_quarantine 失败：', err)
      setEntries([])
      setNoticeMsg(`读取隔离名单失败：${String(err)}`)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false

    // 1. 隔离名单 + fuse summary
    void (async () => {
      await reload()
      if (cancelled) return
      try {
        const s = await invoke<{ disabled: string[]; retried: number }>('get_fuse_summary')
        if (cancelled) return
        if (Array.isArray(s?.disabled) && s.disabled.length) {
          setSummaryText(`本次启动自动禁用了 ${s.disabled.length} 个插件，重试 ${s.retried} 次后成功`)
        }
      } catch {
        /* 通知区读取失败静默降级 */
      }
    })()

    // 2. 设置（#95 收尾：Tauri IPC 直连 Rust 单写者，不再经已删除的宿主设置 RPC；失败回退默认值）
    void (async () => {
      try {
        const v = await invoke<Record<string, unknown>>('get_quarantine_settings')
        if (cancelled) return
        setSettings({
          first_party_protection: (v.first_party_protection as boolean) ?? true,
          exclude: (v.exclude as string[]) ?? [],
          max_retries: (v.max_retries as number) ?? 2,
          ai_provider: (v.ai_provider as string) ?? 'deepseek',
          ai_model: (v.ai_model as string) ?? '',
          ai_base_url: (v.ai_base_url as string) ?? '',
          ai_key_env: (v.ai_key_env as string) ?? '',
        })
      } catch {
        if (cancelled) return
        setSettings(DEFAULT_SETTINGS)
      }
    })()

    // 3. provider 目录（连接 RPC；失败/无连接置为 error）
    void (async () => {
      if (!fuseConnection) {
        setProviderDir({ error: 'connection 不可用（非桌面壳环境）' })
        return
      }
      setProviderDir('loading')
      try {
        const r = await fuseConnection.rpc.call('/dsh-desktop-models', 'list', {})
        if (cancelled) return
        // connection.rpc.call 恒返回信封 {ok, value}（dsh-client-connection 解包规则）
        if (!r?.ok) throw new Error(r?.error?.message ?? 'models 查询失败')
        const providers = r.value?.providers ?? []
        setProviderDir(
          providers.map((p: { id: string; name: string; models?: Array<{ id: string; name?: string }> }) => ({
            id: p.id,
            name: p.name,
            settingsNs: '',
            models: p.models || [],
          })),
        )
      } catch (err) {
        if (cancelled) return
        setProviderDir({ error: String(err) })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [reload])

  // ── 动作 ──

  const saveSettings = React.useCallback(async (next: FuseSettings): Promise<void> => {
    try {
      // #95 收尾：走壳自己的 Tauri IPC（Rust 单写者持久化）；面板注册已有 hasIpc 守卫。
      const r = await invoke<{ ok: boolean; error?: string }>('save_quarantine_settings', {
        firstPartyProtection: next.first_party_protection,
        exclude: next.exclude,
        maxRetries: next.max_retries,
        aiProvider: next.ai_provider || 'deepseek',
        aiModel: next.ai_model || '',
        aiBaseUrl: next.ai_base_url || '',
        aiKeyEnv: next.ai_key_env || '',
      })
      if (!r?.ok) throw new Error(r?.error ?? '保存被拒绝')
    } catch (err) {
      setNoticeMsg(`设置保存失败：${String(err)}`)
    }
  }, [])

  const updateSettings = React.useCallback(
    (mutator: (prev: FuseSettings) => FuseSettings): void => {
      setSettings((prev) => {
        if (!prev) return prev
        const next = mutator(prev)
        void saveSettings(next)
        return next
      })
    },
    [saveSettings],
  )

  const toggleFirstParty = React.useCallback((): void => {
    updateSettings((p) => ({ ...p, first_party_protection: !p.first_party_protection }))
  }, [updateSettings])

  const bumpRetries = React.useCallback((delta: number): void => {
    updateSettings((p) => ({
      ...p,
      max_retries: Math.max(RETRIES_MIN, Math.min(RETRIES_MAX, p.max_retries + delta)),
    }))
  }, [updateSettings])

  const removeExclude = React.useCallback((x: string): void => {
    updateSettings((p) => ({ ...p, exclude: p.exclude.filter((y) => y !== x) }))
  }, [updateSettings])

  const addExclude = React.useCallback((): void => {
    const v = window.prompt('排除的插件 id 或包名：')
    if (!v || !v.trim()) return
    const trimmed = v.trim()
    updateSettings((p) =>
      p.exclude.includes(trimmed) ? p : { ...p, exclude: [...p.exclude, trimmed] },
    )
  }, [updateSettings])

  const changeProvider = React.useCallback(
    (id: string): void => {
      updateSettings((p) => {
        const dir = Array.isArray(providerDir) ? providerDir : null
        const sel = dir?.find((x) => x.id === id)
        const nextModel = sel?.models.length ? sel.models[0].id : p.ai_model
        return { ...p, ai_provider: id, ai_model: nextModel }
      })
    },
    [providerDir, updateSettings],
  )

  const changeModel = React.useCallback(
    (id: string): void => {
      updateSettings((p) => ({ ...p, ai_model: id }))
    },
    [updateSettings],
  )

  const runDoctor = React.useCallback(async (): Promise<void> => {
    if (doctor === 'running') return
    setDoctor('running')
    setDoctorError(null)
    try {
      const r = await invoke<{ checks: DoctorCheck[] }>('run_doctor')
      setDoctor(r.checks)
      console.info(
        '[plugin-fuse] run_doctor 完成：',
        Array.isArray(r.checks) ? `${r.checks.length} 项` : JSON.stringify(r),
      )
    } catch (err) {
      setDoctor('idle')
      setDoctorError(String(err))
      // 错误必须可观测：console 镜像会把这条写进 ~/.dsh/dsh-desktop-webview.log
      console.error('[plugin-fuse] run_doctor 失败：', err)
      setNoticeMsg(`体检失败：${String(err)}`)
    }
  }, [doctor])

  const doRepair = React.useCallback(
    async (id: string): Promise<void> => {
      if (repairBusy) return
      setRepairBusy(id)
      setRepairMsg({ ok: true, text: '修复已派发：dsh plugin add @latest 安装中，通常需 10–30 秒，请勿关闭设置…' })
      try {
        const r = await invoke<{ ok: boolean; message?: string; error?: string }>('repair_plugin', { id })
        setRepairMsg({
          ok: !!r.ok,
          text: r.ok ? (r.message ?? '修复完成，重启 dsh 后生效') : `修复失败：${r.error ?? '未知'}`,
        })
      } catch (err) {
        setRepairMsg({ ok: false, text: `修复失败：${String(err)}` })
      }
      setRepairBusy(null)
      await reload()
    },
    [repairBusy, reload],
  )

  const doExplain = React.useCallback(
    async (id: string): Promise<void> => {
      if (explain[id] === 'loading') return
      setExplain((prev) => ({ ...prev, [id]: 'loading' }))
      try {
        // #96：dsh provider 路由的解读经宿主 RPC 在 dsh 进程内发起（llm 服务单一事实源，
        // 路由/密钥/端点全由 dsh 解析）；custom（自定义端点/密钥）与无连接时回退壳 Rust。
        let r: { ok: boolean; suggestion?: string; error?: string }
        if (settings && settings.ai_provider !== 'custom' && fuseConnection) {
          const e = entries.find((x) => x.id === id)
          // #121：前端超时兜底（宿主侧已有 45s 看门狗；这里 75s 兜底，避免无限 loading）
          const resp = (await Promise.race([
            fuseConnection.rpc.call('/dsh-desktop-fuse-explain', 'run', {
              failureType: e?.failure_type ?? '',
              name: e?.name ?? '',
              rawError: e?.raw_error ?? '',
              provider: settings.ai_provider,
              model: settings.ai_model,
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('解读超时（75 秒无响应）')), 75000)
            }),
          ])) as { ok: boolean; error?: { message?: string }; value?: { ok: boolean; suggestion?: string } }
          if (!resp?.ok) throw new Error(resp?.error?.message ?? '解读被拒绝')
          r = resp.value as { ok: boolean; suggestion?: string }
        } else {
          r = await invoke<{ ok: boolean; suggestion?: string; error?: string }>('explain_failure', { id })
        }
        setExplain((prev) => ({
          ...prev,
          [id]: r.ok && r.suggestion ? r.suggestion : `AI 解读不可用：${r.error ?? '未知'}`,
        }))
      } catch (err) {
        setExplain((prev) => ({ ...prev, [id]: `AI 解读不可用：${String(err)}` }))
      }
    },
    [explain, entries, settings],
  )

  const askRestore = React.useCallback(
    async (id: string): Promise<void> => {
      if (
        !window.confirm(
          `恢复 ${id}？\n\n将从 cordis.patch.yml 托管区块移除 disabled: true 行，恢复后将在下次重启时生效。若新版本 dsh 仍不兼容，下次启动会再次被自动隔离。`,
        )
      )
        return
      try {
        await invoke('restore_quarantine', { ids: [id] })
        await reload()
      } catch (err) {
        setNoticeMsg(`恢复失败：${String(err)}`)
      }
    },
    [reload],
  )

  const toggleRaw = React.useCallback((): void => {
    setShowRaw((prev) => !prev)
  }, [])

  // ── 渲染 ──

  return (
    <div
      data-plugin-fuse="1"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 900,
        fontSize: 13,
      }}
    >
      {summaryText ? <SummaryBanner text={summaryText} /> : null}
      {noticeMsg ? <NoticeBanner text={noticeMsg} /> : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '264px 1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <QuarantineList
            entries={entries}
            selected={safeSelected}
            onSelect={setSelected}
          />
          <DoctorCard doctor={doctor} doctorError={doctorError} onRun={runDoctor} />
          <SettingsCard
            settings={settings}
            providerDir={providerDir}
            showSettings={showSettings}
            onToggleShow={() => setShowSettings((v) => !v)}
            onToggleFirstParty={toggleFirstParty}
            onBumpRetries={bumpRetries}
            onRemoveExclude={removeExclude}
            onAddExclude={addExclude}
            onChangeProvider={changeProvider}
            onChangeModel={changeModel}
          />
        </div>
        <QuarantineDetail
          entry={currentEntry}
          profile={profile}
          repairBusy={repairBusy}
          explainText={currentEntry ? explain[currentEntry.id] : undefined}
          explainModel={settings?.ai_model}
          repairMsg={repairMsg}
          showRaw={showRaw}
          onRepair={doRepair}
          onExplain={doExplain}
          onRestore={askRestore}
          onToggleRaw={toggleRaw}
        />
      </div>
    </div>
  )
}

// ── 子组件 ──────────────────────────────────────────────────────────────

function SummaryBanner({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
        borderLeft: '3px solid var(--dsw-alias-state-warning-primary,#e8a33d)',
        background: 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))',
        borderRadius: 8,
        padding: '10px 12px',
        fontSize: 12.5,
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
    </div>
  )
}

function NoticeBanner({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 12,
        color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
        background: 'rgba(229,83,75,.08)',
        border: '1px solid var(--dsw-alias-state-danger-primary,#e5534b)',
        borderRadius: 8,
        padding: '8px 12px',
        wordBreak: 'break-all',
      }}
    >
      {text}
    </div>
  )
}

function QuarantineList({
  entries,
  selected,
  onSelect,
}: {
  entries: QuarantineEntry[]
  selected: number
  onSelect: (index: number) => void
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {entries.length === 0 ? (
        <div
          style={{
            padding: 14,
            color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
            fontSize: 12.5,
          }}
        >
          当前没有被隔离的插件。
        </div>
      ) : (
        entries.map((e, i) => {
          const isSelected = i === selected
          return (
            <div
              key={e.id}
              className="pf-row"
              onClick={() => onSelect(i)}
              style={{
                padding: '11px 13px',
                borderBottom: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
                background: isSelected
                  ? 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))'
                  : 'transparent',
                boxShadow: isSelected
                  ? 'inset 3px 0 0 var(--dsw-alias-brand-primary-new-color,#4176e6)'
                  : 'none',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <b style={{ fontSize: 12.5 }}>{e.id}</b>
                <span
                  style={{
                    fontSize: 11,
                    border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
                    borderRadius: 6,
                    padding: '1px 7px',
                    color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {TYPE_LABEL[e.failure_type] || e.failure_type}
                </span>
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 11.5,
                  color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {e.reason}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

function DoctorCard({
  doctor,
  doctorError,
  onRun,
}: {
  doctor: DoctorState
  doctorError: string | null
  onRun: () => void
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
        borderRadius: 12,
        padding: '12px 14px',
      }}
    >
      <b style={{ fontSize: 12.5 }}>体检（doctor）</b>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {doctor === 'idle' || doctor === null ? (
          <>
            <div
              style={{
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
              }}
            >
              尚未体检：检查 dsh 版本、DSH_HOME、profiles、台账一致性、托管区块健康。
            </div>
            {doctorError ? (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
                  wordBreak: 'break-all',
                }}
              >
                上次体检失败：{doctorError}
              </div>
            ) : null}
          </>
        ) : doctor === 'running' ? (
          <div
            style={{
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
            }}
          >
            体检中…
          </div>
        ) : (
          doctor.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                fontSize: 12,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  marginTop: 5,
                  flex: 'none',
                  background: c.ok
                    ? 'var(--dsw-alias-state-success-primary,#2fbf71)'
                    : 'var(--dsw-alias-state-danger-primary,#e5534b)',
                }}
              />
              <div>
                <b style={{ fontSize: 12 }}>{c.label}</b>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
                  }}
                >
                  {c.detail}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        className="pf-btn ghost"
        style={{ marginTop: 8 }}
        onClick={() => void onRun()}
        disabled={doctor === 'running'}
      >
        {doctor === 'running' ? '体检中…' : '运行体检'}
      </button>
    </div>
  )
}

function SettingsCard({
  settings,
  providerDir,
  showSettings,
  onToggleShow,
  onToggleFirstParty,
  onBumpRetries,
  onRemoveExclude,
  onAddExclude,
  onChangeProvider,
  onChangeModel,
}: {
  settings: FuseSettings | null
  providerDir: ProviderDirState
  showSettings: boolean
  onToggleShow: () => void
  onToggleFirstParty: () => void
  onBumpRetries: (delta: number) => void
  onRemoveExclude: (x: string) => void
  onAddExclude: () => void
  onChangeProvider: (id: string) => void
  onChangeModel: (id: string) => void
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <div
        onClick={onToggleShow}
        style={{
          padding: '11px 13px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: 12.5,
          userSelect: 'none',
        }}
      >
        <span>设置</span>
        <span style={{ color: 'var(--dsw-alias-label-secondary,#9aa4b2)' }}>
          {showSettings ? '▾' : '▸'}
        </span>
      </div>
      {showSettings && settings ? (
        <SettingsBody
          settings={settings}
          providerDir={providerDir}
          onToggleFirstParty={onToggleFirstParty}
          onBumpRetries={onBumpRetries}
          onRemoveExclude={onRemoveExclude}
          onAddExclude={onAddExclude}
          onChangeProvider={onChangeProvider}
          onChangeModel={onChangeModel}
        />
      ) : null}
    </div>
  )
}

function SettingsBody({
  settings,
  providerDir,
  onToggleFirstParty,
  onBumpRetries,
  onRemoveExclude,
  onAddExclude,
  onChangeProvider,
  onChangeModel,
}: {
  settings: FuseSettings
  providerDir: ProviderDirState
  onToggleFirstParty: () => void
  onBumpRetries: (delta: number) => void
  onRemoveExclude: (x: string) => void
  onAddExclude: () => void
  onChangeProvider: (id: string) => void
  onChangeModel: (id: string) => void
}): React.ReactElement {
  const selProvider = Array.isArray(providerDir)
    ? providerDir.find((p) => p.id === settings.ai_provider)
    : undefined
  const models = selProvider?.models ?? []

  return (
    <div
      style={{
        padding: '0 13px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontSize: 12,
      }}
    >
      {/* 第一方保护开关 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <span>第一方插件保护（@deepseek-ai/* 不自动禁用）</span>
        <span
          role="switch"
          aria-checked={settings.first_party_protection}
          tabIndex={0}
          className={`pf-toggle ${settings.first_party_protection ? 'on' : 'off'}`}
          onClick={onToggleFirstParty}
          onKeyDown={(ev: React.KeyboardEvent<HTMLSpanElement>) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault()
              onToggleFirstParty()
            }
          }}
        >
          <span className="knob" />
        </span>
      </div>

      {/* 重试次数 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <span>启动失败最大重试次数</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            className="pf-btn ghost sm"
            onClick={() => onBumpRetries(-1)}
            aria-label="减少重试次数"
          >
            −
          </button>
          <b>{settings.max_retries}</b>
          <button
            type="button"
            className="pf-btn ghost sm"
            onClick={() => onBumpRetries(1)}
            aria-label="增加重试次数"
          >
            ＋
          </button>
        </span>
      </div>

      {/* 排除名单 */}
      <div>
        <div
          style={{
            marginBottom: 6,
            color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
          }}
        >
          排除名单（永不自动禁用，点击 ✕ 移除）
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {settings.exclude.map((x) => (
            <span
              key={x}
              className="pf-chip"
              onClick={() => onRemoveExclude(x)}
              title="点击移除"
              style={{
                fontSize: 11,
                border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
                padding: '2px 7px',
                color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
              }}
            >
              {x} ✕
            </span>
          ))}
          <span
            className="pf-chip"
            onClick={onAddExclude}
            style={{
              fontSize: 11,
              border: '1px dashed var(--dsw-alias-border-l,#ffffff1f)',
              padding: '2px 7px',
              color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
            }}
          >
            ＋ 添加
          </span>
        </div>
      </div>

      {/* AI 解读路由：从 dsh llm 目录服务动态拉取已注册的 provider + 模型 */}
      <div style={{ fontWeight: 600, fontSize: 12 }}>AI 解读（explain）</div>
      <ProviderSelect providerDir={providerDir} value={settings.ai_provider} onChange={onChangeProvider} />
      <div
        style={{
          fontSize: 11,
          color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
          marginTop: 6,
        }}
      >
        模型
      </div>
      <ModelSelect
        models={models}
        value={settings.ai_model}
        disabled={!models.length}
        disabledLabel={selProvider ? '该 provider 无已安装模型' : '未选中 provider'}
        onChange={onChangeModel}
      />
      <div
        style={{
          fontSize: 11,
          color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
        }}
      >
        Provider 与模型列表从 dsh llm 目录服务动态获取（与 dsh-mnemon 同一数据源）。
      </div>
    </div>
  )
}

function ProviderSelect({
  providerDir,
  value,
  onChange,
}: {
  providerDir: ProviderDirState
  value: string
  onChange: (id: string) => void
}): React.ReactElement {
  if (providerDir === 'loading') {
    return (
      <select className="pf-select" disabled defaultValue="">
        <option>加载中…</option>
      </select>
    )
  }
  if (providerDir && !Array.isArray(providerDir)) {
    return (
      <select className="pf-select" disabled defaultValue="">
        <option>加载失败：{providerDir.error}</option>
      </select>
    )
  }
  const list = Array.isArray(providerDir) ? providerDir : []
  if (!list.length) {
    return (
      <select className="pf-select" disabled defaultValue="">
        <option>dsh 未注册任何 provider</option>
      </select>
    )
  }
  return (
    <select
      className="pf-select"
      value={value}
      onChange={(ev: React.ChangeEvent<HTMLSelectElement>) => onChange(ev.target.value)}
    >
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}（{p.models.length} 个模型）
        </option>
      ))}
    </select>
  )
}

function ModelSelect({
  models,
  value,
  disabled,
  disabledLabel,
  onChange,
}: {
  models: Array<{ id: string; name?: string }>
  value: string
  disabled: boolean
  disabledLabel: string
  onChange: (id: string) => void
}): React.ReactElement {
  if (disabled) {
    return (
      <select className="pf-select" disabled defaultValue="">
        <option>{disabledLabel}</option>
      </select>
    )
  }
  return (
    <select
      className="pf-select"
      style={{ marginTop: 6 }}
      value={value}
      onChange={(ev: React.ChangeEvent<HTMLSelectElement>) => onChange(ev.target.value)}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name || m.id}
        </option>
      ))}
    </select>
  )
}

function QuarantineDetail({
  entry,
  profile,
  repairBusy,
  explainText,
  repairMsg,
  showRaw,
  onRepair,
  onExplain,
  onRestore,
  onToggleRaw,
  explainModel,
}: {
  entry: QuarantineEntry | undefined
  profile: string
  repairBusy: string | null
  explainText: string | 'loading' | null | undefined
  repairMsg: { ok: boolean; text: string } | null
  showRaw: boolean
  onRepair: (id: string) => void
  onExplain: (id: string) => void
  onRestore: (id: string) => void
  onToggleRaw: () => void
  /** 当前设置的解读模型（由 FusePanel 传入；本组件作用域内没有 settings）。 */
  explainModel?: string
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
        borderRadius: 12,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignSelf: 'start',
        minHeight: 220,
      }}
    >
      {!entry ? (
        <div
          style={{
            color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
            fontSize: 12.5,
          }}
        >
          选择左侧记录查看详情。
        </div>
      ) : (
        <DetailBody
          entry={entry}
          profile={profile}
          repairBusy={repairBusy}
          explainText={explainText}
          repairMsg={repairMsg}
          showRaw={showRaw}
          onRepair={onRepair}
          onExplain={onExplain}
          onRestore={onRestore}
          onToggleRaw={onToggleRaw}
          explainModel={explainModel}
        />
      )}
    </div>
  )
}

function DetailBody({
  entry,
  profile,
  repairBusy,
  explainText,
  repairMsg,
  showRaw,
  onRepair,
  onExplain,
  onRestore,
  onToggleRaw,
  explainModel,
}: {
  entry: QuarantineEntry
  profile: string
  repairBusy: string | null
  explainText: string | 'loading' | null | undefined
  repairMsg: { ok: boolean; text: string } | null
  showRaw: boolean
  onRepair: (id: string) => void
  onExplain: (id: string) => void
  onRestore: (id: string) => void
  onToggleRaw: () => void
  /** 当前设置的解读模型（#96 后实际由 dsh 路由使用）——用于 loading 文案与实际一致。 */
  explainModel?: string
}): React.ReactElement {
  const e = entry
  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <b style={{ fontSize: 14 }}>{e.id}</b>
        <span
          style={{
            fontSize: 11,
            border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
            borderRadius: 6,
            padding: '1px 7px',
            color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
          }}
        >
          {TYPE_LABEL[e.failure_type] || e.failure_type}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--dsw-alias-state-danger-primary,#e5534b)',
          wordBreak: 'break-all',
        }}
      >
        {e.reason}
      </div>
      <pre
        className="pf-raw"
        onClick={onToggleRaw}
        title="点击展开/折叠"
        style={{
          background: 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))',
          border: '1px solid var(--dsw-alias-border-l,#ffffff1f)',
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 11.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
          maxHeight: showRaw ? 150 : 'none',
          overflow: 'auto',
          margin: 0,
        }}
      >
        {e.raw_error}
      </pre>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 14px',
          fontSize: 12,
          margin: 0,
        }}
      >
        <MetaRow k="失败类型" v={`${TYPE_LABEL[e.failure_type] || e.failure_type}（${e.failure_type}）`} />
        <MetaRow k="禁用时间" v={e.quarantined_at} />
        <MetaRow k="profile" v={profile} />
        <MetaRow k="patch 文件" v={e.file} />
        <MetaRow k="包名/来源" v={e.name} />
      </dl>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {e.repairable ? (
          <button
            type="button"
            className="pf-btn ghost"
            onClick={() => onRepair(e.id)}
            disabled={repairBusy === e.id}
          >
            {repairBusy === e.id ? '修复中…' : '修复'}
          </button>
        ) : null}
        <button
          type="button"
          className="pf-btn ghost"
          onClick={() => onExplain(e.id)}
          disabled={explainText === 'loading'}
        >
          {explainText === 'loading' ? 'AI 解读中…' : 'AI 解读'}
        </button>
        <button
          type="button"
          className="pf-btn danger"
          onClick={() => void onRestore(e.id)}
        >
          恢复
        </button>
      </div>
      {repairMsg ? (
        <div
          style={{
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            border: `1px solid ${repairMsg.ok ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-state-danger-primary,#e5534b)'}`,
            borderRadius: 12,
            padding: '10px 14px',
            wordBreak: 'break-all',
          }}
        >
          {repairMsg.text}
        </div>
      ) : null}
      {explainText === 'loading' ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
          }}
        >
          {explainModel ? `AI 解读中…（${explainModel}）` : 'AI 解读中…'}
        </div>
      ) : typeof explainText === 'string' ? (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
              marginBottom: 4,
            }}
          >
            AI 解读 · 仅供参考
          </div>
          <div
            style={{
              fontSize: 12.5,
              whiteSpace: 'pre-wrap',
              border: '1px solid var(--dsw-alias-brand-primary-new-color,#4176e6)',
              borderRadius: 12,
              padding: '12px 14px',
            }}
          >
            {explainText}
          </div>
        </>
      ) : null}
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
        }}
      >
        恢复 / 修复只改 patch 文件与台账，重启 dsh 后生效。
      </div>
    </>
  )
}

function MetaRow({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <>
      <dt
        style={{
          color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
        }}
      >
        {k}
      </dt>
      <dd
        style={{
          margin: 0,
          color: 'var(--dsw-alias-label-secondary,#9aa4b2)',
          wordBreak: 'break-all',
        }}
      >
        {v}
      </dd>
    </>
  )
}
