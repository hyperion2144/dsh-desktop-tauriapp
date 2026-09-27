/**
 * 桌面通知设置 Tab（#142 / 规格 #143 / T4 原型 A「分区列表」布局）。
 *
 * 注入 dsh 设置弹窗的 settings.section 槽位（同 desktop-settings.tsx 模式）。
 * 结构：权限卡（三态 + 申请/打开系统设置）→ 总开关 → 免打扰（时段+全屏静默）→
 * 场景区（6 组 12 行：名称+id·说明 | 开关 | 音效下拉 | 试听▶）。
 * 数据面：get_notifications_state 一次拉全；改动即时 set_notifications_config 落盘
 * （Rust 单写者）；音效选择经 choose_notification_sound + import_notification_sound。
 * 权限被拒（macOS 27 对 ad-hoc 签名的静默拒绝，#130/#142）：引导打开系统设置手动开启。
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { ClientContext } from './ctx-types.ts'

export const inject = ['slots']

interface ScenarioRow {
  id: string
  group: string
  name: string
  desc: string
  defaultOn: boolean
  config: { enabled: boolean; sound: string } | null
}
interface NotificationState {
  permission: string
  config: {
    enabled: boolean
    dnd: { on: boolean; from: string; to: string; suppress_fullscreen: boolean }
    scenarios: Record<string, { enabled: boolean; sound: string }>
  }
  scenarios: ScenarioRow[]
  groups: [string, string][]
  sounds: string[]
}

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<T> }
    __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<T> } }
  }
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke(cmd, args)
  if (w.__TAURI__?.core?.invoke) return w.__TAURI__!.core.invoke(cmd, args)
  return Promise.reject(new Error('no tauri ipc'))
}

const SYS_PREFS = 'x-apple.systempreferences:com.apple.Preference.Notifications'

// ── 主题 token：真实 dsh 变量名 + 回退值（独立打开时生效）──
const PANEL_CSS = `
[data-notification-settings] { font-size: 13px; }
[data-notification-settings] .n-card { border:1px solid var(--dsw-alias-border-l,#ffffff1f); border-radius:12px; padding:12px 16px; margin-bottom:10px; }
[data-notification-settings] .n-banner { display:flex; gap:10px; align-items:center; border:1px solid var(--dsw-alias-border-l,#ffffff1f); border-left:3px solid var(--dsw-alias-state-warn,#e8a33d); background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); border-radius:8px; padding:9px 12px; font-size:12.5px; margin-bottom:10px; }
[data-notification-settings] .n-banner.granted { border-left-color:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-banner.denied { border-left-color:var(--dsw-alias-state-danger,#e5534b); }
[data-notification-settings] .n-banner .grow { flex:1; min-width:0; }
[data-notification-settings] .n-chip { display:inline-block; font-size:11px; border:1px solid var(--dsw-alias-border-l,#ffffff1f); border-radius:6px; padding:1px 7px; color:var(--dsw-alias-label-secondary,#9aa4b2); white-space:nowrap; }
[data-notification-settings] .n-chip.ok { color:var(--dsw-alias-state-success,#2fbf71); border-color:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-chip.warn { color:var(--dsw-alias-state-warn,#e8a33d); border-color:var(--dsw-alias-state-warn,#e8a33d); }
[data-notification-settings] .n-chip.danger { color:var(--dsw-alias-state-danger,#e5534b); border-color:var(--dsw-alias-state-danger,#e5534b); }
[data-notification-settings] .n-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
[data-notification-settings] .n-btn:hover { filter:brightness(1.12); }
[data-notification-settings] .n-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-notification-settings] .n-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-notification-settings] .n-btn.mini { padding:2px 9px; font-size:11px; }
[data-notification-settings] .n-btn:disabled { opacity:.45; cursor:default; filter:none; }
[data-notification-settings] .n-switch { position:relative; width:34px; height:19px; border-radius:999px; background:var(--dsw-alias-border-l,#ffffff1f); cursor:pointer; flex:none; transition:background .15s; display:inline-block; vertical-align:middle; }
[data-notification-settings] .n-switch.on { background:var(--dsw-alias-state-success,#2fbf71); }
[data-notification-settings] .n-switch::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--dsw-alias-bg-base,#151517); transition:left .15s; }
[data-notification-settings] .n-switch.on::after { left:17px; }
[data-notification-settings] .n-setrow { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12.5px; }
[data-notification-settings] .n-srow { display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l,#ffffff1f); }
[data-notification-settings] .n-grp:last-child .n-srow:last-child { border-bottom:none; }
[data-notification-settings] .n-sinfo { flex:1; min-width:0; }
[data-notification-settings] .n-sinfo b { font-size:12.5px; font-weight:600; }
[data-notification-settings] .n-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px; color:var(--dsw-alias-label-secondary,#9aa4b2); }
[data-notification-settings] .n-gname { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); letter-spacing:.4px; margin:10px 0 2px; }
[data-notification-settings] .n-select, [data-notification-settings] .n-time { font:inherit; font-size:12px; color:inherit; background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); border-radius:8px; padding:3px 7px; }
[data-notification-settings] .n-note { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-top:8px; }
[data-notification-settings] .n-mastoff .n-srow .n-switch, [data-notification-settings] .n-mastoff .n-srow select, [data-notification-settings] .n-mastoff .n-srow button { opacity:.4; pointer-events:none; }
[data-notification-settings] input[type="time"] { color-scheme: inherit; }
`

let stylesInstalled = false
function ensureStyles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

function NotificationSettingsPanel(): React.ReactElement {
  const [data, setData] = useState<NotificationState | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback((): void => {
    invoke<NotificationState>('get_notifications_state')
      .then(setData)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const save = useCallback((next: NotificationState['config']): void => {
    setBusy(true)
    invoke('set_notifications_config', { config: next })
      .catch((e) => { logFail(e) })
      .finally(() => setBusy(false))
  }, [])

  const logFail = (e: unknown): void => {
    const w = window as unknown as { __xnlLogWarn?: (m: string) => void }
    w.__xnlLogWarn?.(String(e))
    console.warn('[notifications] 保存失败', e)
  }

  const patch = useCallback((fn: (c: NotificationState['config']) => void): void => {
    setData((prev) => {
      if (prev === null) return prev
      const next = {
        enabled: prev.config.enabled,
        dnd: { ...prev.config.dnd },
        scenarios: Object.fromEntries(
          Object.entries(prev.config.scenarios).map(([k, v]) => [k, { ...v }]),
        ),
      }
      fn(next)
      save(next)
      return { ...prev, config: next }
    })
  }, [save])

  if (data === null) {
    return <div data-notification-settings className="n-note">加载中…</div>
  }


  const requestPerm = (): void => {
    setBusy(true)
    invoke<string>('request_notification_permission_cmd')
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  const openSysPrefs = (): void => {
    void invoke('open_external', { url: SYS_PREFS }).catch(() => {})
  }

  const chooseSound = (): void => {
    invoke<string | null>('choose_notification_sound')
      .then((path) => {
        if (path === null || path === undefined || path === '') return
        return invoke<string>('import_notification_sound', { path }).then((name) => {
          refresh()
          return name
        })
      })
      .catch((e) => console.warn('[notifications] 导入音效失败', e))
  }

  const groupLabel = (gid: string): string => data.groups.find(([g]) => g === gid)?.[1] ?? gid
  const grouped = data.groups.map(([gid]) => ({
    gid,
    rows: data.scenarios.filter((s) => s.group === gid),
  }))

  return (
    <div data-notification-settings className={data.config.enabled ? '' : 'n-mastoff'}>
      {/* 权限卡 */}
      {data.permission === 'granted' ? (
        <div className="n-banner granted">
          <span className="n-chip ok">已授予</span>
          <span className="grow">系统允许本应用发送通知。</span>
          <button className="n-btn ghost mini" onClick={openSysPrefs}>打开系统设置</button>
        </div>
      ) : data.permission === 'denied' ? (
        <div className="n-banner denied">
          <span className="n-chip danger">被拒绝</span>
          <span className="grow">通知横幅不会显示。可在系统设置中手动开启；开发期可执行 tccutil reset Notifications com.arcreel.dsh-desktop-tauriapp 后重试。</span>
          <button className="n-btn ghost mini" onClick={openSysPrefs}>打开系统设置</button>
          <button className="n-btn mini" onClick={requestPerm} disabled={busy}>申请权限</button>
        </div>
      ) : data.permission === 'unavailable' ? (
        <div className="n-banner">
          <span className="n-chip">权限不可用</span>
          <span className="grow">当前环境无法查询系统通知权限（dev 裸二进制或平台不支持）；验收请使用打包后的 .app。</span>
        </div>
      ) : (
        <div className="n-banner">
          <span className="n-chip warn">未决定</span>
          <span className="grow">尚未向系统申请通知权限，首次申请会弹系统授权窗。</span>
          <button className="n-btn mini" onClick={requestPerm} disabled={busy}>申请权限</button>
          <button className="n-btn ghost mini" onClick={openSysPrefs}>打开系统设置</button>
        </div>
      )}

      {/* 总开关 */}
      <div className="n-card">
        <div className="n-setrow">
          <div>
            <b>启用桌面通知</b>
            <div className="n-note">总开关：关闭后所有场景一律静默（场景开关保留，重新开启即恢复）</div>
          </div>
          <span
            className={`n-switch ${data.config.enabled ? 'on' : ''}`}
            onClick={() => patch((c) => { c.enabled = !c.enabled })}
          />
        </div>
      </div>

      {/* 免打扰 */}
      <div className="n-card">
        <div className="n-setrow" style={{ marginBottom: 10 }}>
          <div>
            <b>免打扰时段</b>
            <div className="n-note">时段内通知静默（仍进系统通知中心）</div>
          </div>
          <span
            className={`n-switch ${data.config.dnd.on ? 'on' : ''}`}
            onClick={() => patch((c) => { c.dnd.on = !c.dnd.on })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, opacity: data.config.dnd.on ? 1 : 0.45 }}>
          <span className="n-note" style={{ margin: 0 }}>从</span>
          <input
            className="n-time"
            type="time"
            value={data.config.dnd.from}
            disabled={!data.config.dnd.on}
            onChange={(e) => patch((c) => { c.dnd.from = e.target.value })}
          />
          <span className="n-note" style={{ margin: 0 }}>到</span>
          <input
            className="n-time"
            type="time"
            value={data.config.dnd.to}
            disabled={!data.config.dnd.on}
            onChange={(e) => patch((c) => { c.dnd.to = e.target.value })}
          />
        </div>
        <div className="n-setrow">
          <div>
            <b>全屏时静默</b>
            <div className="n-note">本应用窗口全屏时不弹横幅</div>
          </div>
          <span
            className={`n-switch ${data.config.dnd.suppress_fullscreen ? 'on' : ''}`}
            onClick={() => patch((c) => { c.dnd.suppress_fullscreen = !c.dnd.suppress_fullscreen })}
          />
        </div>
      </div>

      {/* 场景 */}
      <div className="n-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <b style={{ fontSize: 13 }}>场景</b>
          <span className="n-note">每个场景独立开关与音效</span>
        </div>
        {grouped.map(({ gid, rows }) => (
          <div className="n-grp" key={gid}>
            <div className="n-gname">{groupLabel(gid)}</div>
            {rows.map((s) => {
              const conf = data.config.scenarios[s.id] ?? { enabled: s.defaultOn, sound: 'default' }
              return (
                <div className="n-srow" key={s.id}>
                  <div className="n-sinfo">
                    <b>{s.name}</b>
                    <span className="n-mono" style={{ display: 'block' }}>{s.id} · {s.desc}</span>
                  </div>
                  <span
                    className={`n-switch ${conf.enabled ? 'on' : ''}`}
                    onClick={() => patch((c) => {
                      const cur = c.scenarios[s.id] ?? { enabled: s.defaultOn, sound: 'default' }
                      c.scenarios[s.id] = { ...cur, enabled: !cur.enabled }
                    })}
                  />
                  <select
                    className="n-select"
                    style={{ minWidth: 126 }}
                    value={conf.sound}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '__choose') chooseSound()
                      else patch((c) => {
                        const cur = c.scenarios[s.id] ?? { enabled: s.defaultOn, sound: 'default' }
                        c.scenarios[s.id] = { ...cur, sound: v === '__default' ? 'default' : v }
                      })
                    }}
                  >
                    <option value="default">系统默认</option>
                    <option value="none">无声</option>
                    {data.sounds.map((n) => (
                      <option key={n} value={`custom:${n}`}>{n}</option>
                    ))}
                    <option value="__choose">自定义文件…</option>
                  </select>
                  <button
                    className="n-btn ghost mini"
                    title="试听"
                    onClick={() => { void invoke('preview_notification_sound', { sound: conf.sound }).catch(() => {}) }}
                  >
                    ▶
                  </button>
                </div>
              )
            })}
          </div>
        ))}
         <div className="n-note">
           自定义音效文件（wav / mp3 / ogg，≤5MB）导入后存放于数据目录 sounds/，可随时在下拉中切换或覆盖。{busy ? ' · 保存中…' : ''}
         </div>
        </div>
      </div>
  )
}

/** 注册「桌面通知」设置 tab（settings.section 槽位；同桌面设置模式）。 */
export function registerNotificationsTab(ctx: ClientContext): void {
  ensureStyles()
  const slots = (ctx as unknown as {
    slots?: {
      inject: (name: string, fn: () => void) => void
      register: (meta: Record<string, unknown>, comp: unknown) => void
    }
  }).slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'dsh-notification-settings', order: 41, label: () => '桌面通知' },
      NotificationSettingsPanel,
    ),
  )
}
