// 插件保险丝设置面板（#59，布局按 #55 定稿：变体 A 分栏主从）。
// 通过 settings.section 槽位注册（与 dsh-mobile-access 同一契约）；
// 数据经 Tauri IPC 与 Rust 后端通信；纯浏览器（无 IPC）不注册。
// 主题只用 --dsw-alias-* 变量（带回退值），禁止 hash 类名（仓库血泪坑 #8）。
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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

/** 隔离记录（与 Rust list_quarantine 返回对齐）。 */
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
}

const TYPE_LABEL: Record<string, string> = {
  'load-list': '加载失败',
  activation: '激活失败',
  'loader-entry': 'loader entry',
  'stack-id': '外层栈',
  'duplicate-id': '重复挂载',
  'patch-parse': 'patch 解析失败',
}

function el(tag: string, text?: string, style?: string): HTMLElement {
  const e = document.createElement(tag)
  if (text != null) e.textContent = text
  if (style) e.style.cssText = style
  return e
}

function frag(html: string): DocumentFragment {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content
}

/** 注册 settings.section「插件保险丝」。 */
export function registerFusePanel(ctx: ClientContext): void {
  if (!hasIpc()) {
    ctx?.logger?.warn?.('plugin-fuse: 无 Tauri IPC（纯浏览器），跳过设置入口')
    return
  }
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
      FusePanel,
    ),
  )
}

/** React 容器契约（同 mobile-access）：返回 React 元素（不能返回裸 HTMLElement——
 * React 无法渲染真实 DOM 节点，会直接报错变空白）；useEffect 内挂 DOM 面板。 */
function FusePanel(): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const host = ref.current
    if (!host || host.childNodes.length) return
    let panel: HTMLElement
    try {
      panel = buildPanel()
    } catch (err) {
      panel = el('div', `插件保险丝面板初始化失败：${String(err)}`, 'color:#e5534b;font-size:12px;')
    }
    host.appendChild(panel)
    return () => {
      try {
        panel.remove()
      } catch {
        /* noop */
      }
    }
  }, [])
  return React.createElement('div', { ref })
}

let panelStylesInstalled = false
/** 面板交互样式：hover/active 反馈必须走真样式表（内联 cssText 写不了伪类）。 */
function ensurePanelStyles(): void {
  if (panelStylesInstalled) return
  panelStylesInstalled = true
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
[data-plugin-fuse] .pf-row { transition:background .12s; }
[data-plugin-fuse] .pf-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06)); }
[data-plugin-fuse] .pf-chip { transition:background .12s; border-radius:6px; }
[data-plugin-fuse] .pf-chip:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); }
`
  document.head.appendChild(style)
}

function buildPanel(): HTMLElement {
  const state = {
    selected: 0,
    entries: [] as QuarantineEntry[],
    profile: 'web',
    doctor: null as null | 'idle' | 'running' | DoctorCheck[],
    explain: {} as Record<string, null | 'loading' | string>,
    settings: null as FuseSettings | null,
    showSettings: false,
    showRaw: true,
    doctorError: null as string | null,
  }

  const root = el('div', undefined, 'display:flex;flex-direction:column;gap:12px;max-width:900px;font-size:13px;')
  root.dataset.pluginFuse = '1'
  ensurePanelStyles()

  async function reload(): Promise<void> {
    try {
      const resp = await invoke<ListQuarantineResp>('list_quarantine')
      state.profile = resp.profile
      state.entries = resp.entries
    } catch (err) {
      console.error('[plugin-fuse] list_quarantine 失败：', err)
      state.entries = []
      root.appendChild(el('div', `读取隔离名单失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
  }

  async function loadSummary(): Promise<void> {
    try {
      const s = await invoke<{ disabled: string[]; retried: number }>('get_fuse_summary')
      if (Array.isArray(s?.disabled) && s.disabled.length) {
        state.summaryText = `本次启动自动禁用了 ${s.disabled.length} 个插件，重试 ${s.retried} 次后成功`
      }
    } catch {
      /* 通知区读取失败静默降级 */
    }
  }
  ;(state as { summaryText?: string }).summaryText = ''

  function render(): void {
    root.replaceChildren()
    const summaryText = (state as { summaryText?: string }).summaryText
    if (summaryText) {
      root.appendChild(frag(`<div style="display:flex;gap:10px;align-items:center;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-left:3px solid var(--dsw-alias-state-warning-primary,#e8a33d);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border-radius:8px;padding:10px 12px;font-size:12.5px"><span style="flex:1">${summaryText}</span></div>`))
    }
    // ── 分栏 ──
    const wrap = el('div', undefined, 'display:grid;grid-template-columns:264px 1fr;gap:16px;align-items:start;')
    // 左列
    const left = el('div', undefined, 'display:flex;flex-direction:column;gap:12px;')
    const list = el('div', undefined, 'border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;overflow:hidden;')
    if (!state.entries.length) {
      list.appendChild(el('div', '当前没有被隔离的插件。', 'padding:14px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12.5px;'))
    }
    state.entries.forEach((e, i) => {
      const row = el('div', undefined, `padding:11px 13px;border-bottom:1px solid var(--dsw-alias-border-l,#ffffff1f);cursor:pointer;${i === state.selected ? 'background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary-new-color,#4176e6);' : ''}`)
      row.className = 'pf-row'
      const top = el('div', undefined, 'display:flex;justify-content:space-between;gap:8px;align-items:center;')
      top.appendChild(el('b', e.id, 'font-size:12.5px;'))
      top.appendChild(el('span', TYPE_LABEL[e.failure_type] || e.failure_type, 'font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap;'))
      row.appendChild(top)
      row.appendChild(el('div', e.reason, 'margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'))
      row.addEventListener('click', () => {
        state.selected = i
        render()
      })
      list.appendChild(row)
    })
    left.appendChild(list)
    // 体检卡
    const doctorCard = el('div', undefined, 'border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:12px 14px;')
    doctorCard.appendChild(el('b', '体检（doctor）', 'font-size:12.5px;'))
    const doctorBody = el('div', undefined, 'margin-top:8px;display:flex;flex-direction:column;gap:6px;')
    if (state.doctor === 'idle' || state.doctor === null) {
      doctorBody.appendChild(el('div', '尚未体检：检查 dsh 版本、DSH_HOME、profiles、台账一致性、托管区块健康。', 'font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
      if (state.doctorError) {
        doctorBody.appendChild(el('div', `上次体检失败：${state.doctorError}`, 'font-size:12px;color:var(--dsw-alias-state-danger-primary,#e5534b);word-break:break-all;'))
      }
    } else if (state.doctor === 'running') {
      doctorBody.appendChild(el('div', '体检中…', 'font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
    } else {
      for (const c of state.doctor) {
        const row = el('div', undefined, 'display:flex;gap:8px;align-items:flex-start;font-size:12px;')
        const dot = el('span', undefined, `width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;background:${c.ok ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-state-danger-primary,#e5534b)'};`)
        const text = el('div')
        text.appendChild(el('b', c.label, 'font-size:12px;'))
        text.appendChild(el('div', c.detail, 'font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
        row.append(dot, text)
        doctorBody.appendChild(row)
      }
    }
    const doctorBtn = el('button', state.doctor === 'running' ? '体检中…' : '运行体检')
    doctorBtn.className = 'pf-btn ghost'
    doctorBtn.style.marginTop = '8px'
    doctorBtn.addEventListener('click', () => void runDoctor())
    doctorCard.appendChild(doctorBody)
    doctorCard.appendChild(doctorBtn)
    left.appendChild(doctorCard)
    // 设置折叠卡
    const setCard = el('div', undefined, 'border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;overflow:hidden;')
    const setHead = el('div', undefined, 'padding:11px 13px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:600;font-size:12.5px;')
    setHead.appendChild(el('span', '设置'))
    setHead.appendChild(el('span', state.showSettings ? '▾' : '▸', 'color:var(--dsw-alias-label-secondary,#9aa4b2);'))
    setHead.addEventListener('click', () => {
      state.showSettings = !state.showSettings
      render()
    })
    setCard.appendChild(setHead)
    if (state.showSettings && state.settings) {
      const body = el('div', undefined, 'padding:0 13px 12px;display:flex;flex-direction:column;gap:10px;font-size:12px;')
      // 第一方保护开关
      const fpRow = el('div', undefined, 'display:flex;justify-content:space-between;gap:10px;align-items:center;')
      fpRow.appendChild(el('span', '第一方插件保护（@deepseek-ai/* 不自动禁用）'))
      const sw = el('span', undefined, `position:relative;width:34px;height:19px;border-radius:999px;cursor:pointer;flex:none;background:${state.settings.first_party_protection ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-border-l,#ffffff1f)'};`)
      sw.style.cssText += `position:relative;`
      const knob = el('span', undefined, `position:absolute;top:2px;left:${state.settings.first_party_protection ? '17px' : '2px'};width:15px;height:15px;border-radius:50%;background:#fff;`)
      sw.appendChild(knob)
      sw.addEventListener('click', () => {
        state.settings!.first_party_protection = !state.settings!.first_party_protection
        void saveSettings()
      })
      fpRow.appendChild(sw)
      body.appendChild(fpRow)
      // 重试次数
      const rtRow = el('div', undefined, 'display:flex;justify-content:space-between;gap:10px;align-items:center;')
      rtRow.appendChild(el('span', '启动失败最大重试次数'))
      const rt = el('span', undefined, 'display:flex;gap:6px;align-items:center;')
      const minus = el('button', '−'); const plus = el('button', '＋')
      minus.className = 'pf-btn ghost sm'
      plus.className = 'pf-btn ghost sm'
      minus.addEventListener('click', () => {
        state.settings!.max_retries = Math.max(0, state.settings!.max_retries - 1)
        void saveSettings()
      })
      plus.addEventListener('click', () => {
        state.settings!.max_retries = Math.min(5, state.settings!.max_retries + 1)
        void saveSettings()
      })
      rt.append(minus, el('b', String(state.settings.max_retries)), plus)
      rtRow.appendChild(rt)
      body.appendChild(rtRow)
      // 排除名单
      const exclWrap = el('div')
      exclWrap.appendChild(el('div', '排除名单（永不自动禁用，点击 ✕ 移除）', 'margin-bottom:6px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
      const chips = el('div', undefined, 'display:flex;flex-wrap:wrap;gap:6px;')
      for (const x of state.settings.exclude) {
        const chip = el('span', `${x} ✕`, 'font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2);')
        chip.className = 'pf-chip'
        chip.addEventListener('click', () => {
          state.settings!.exclude = state.settings!.exclude.filter((y) => y !== x)
          void saveSettings()
        })
        chips.appendChild(chip)
      }
      const addChip = el('span', '＋ 添加', 'font-size:11px;border:1px dashed var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:2px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2);')
      addChip.className = 'pf-chip'
      addChip.addEventListener('click', () => {
        const v = window.prompt('排除的插件 id 或包名：')
        if (v && v.trim()) {
          state.settings!.exclude.push(v.trim())
          void saveSettings()
        }
      })
      chips.appendChild(addChip)
      exclWrap.appendChild(chips)
      body.appendChild(exclWrap)
      setCard.appendChild(body)
    }
    left.appendChild(setCard)
    wrap.appendChild(left)
    // 右详情
    const right = el('div', undefined, 'border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;align-self:start;min-height:220px;')
    const e = state.entries[Math.min(state.selected, Math.max(state.entries.length - 1, 0))]
    if (!e) {
      right.appendChild(el('div', '选择左侧记录查看详情。', 'color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12.5px;'))
    } else {
      const head = el('div', undefined, 'display:flex;justify-content:space-between;align-items:center;gap:8px;')
      head.appendChild(el('b', e.id, 'font-size:14px;'))
      head.appendChild(el('span', TYPE_LABEL[e.failure_type] || e.failure_type, 'font-size:11px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
      right.appendChild(head)
      right.appendChild(el('div', e.reason, 'font-size:13px;color:var(--dsw-alias-state-danger-primary,#e5534b);word-break:break-all;'))
      const raw = el('pre', e.raw_error, 'background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:8px;padding:10px 12px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary,#9aa4b2);max-height:150px;overflow:auto;margin:0;cursor:pointer;')
      raw.addEventListener('click', () => {
        state.showRaw = !state.showRaw
        raw.style.maxHeight = state.showRaw ? '150px' : 'none'
      })
      right.appendChild(raw)
      const meta = el('dl', undefined, 'display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px;margin:0;')
      const put = (k: string, v: string): void => {
        meta.appendChild(el('dt', k, 'color:var(--dsw-alias-label-secondary,#9aa4b2);'))
        meta.appendChild(el('dd', v, 'margin:0;color:var(--dsw-alias-label-secondary,#9aa4b2);word-break:break-all;'))
      }
      put('失败类型', `${TYPE_LABEL[e.failure_type] || e.failure_type}（${e.failure_type}）`)
      put('禁用时间', e.quarantined_at)
      put('profile', state.profile)
      put('patch 文件', e.file)
      put('包名/来源', e.name)
      right.appendChild(meta)
      // 操作行
      const actions = el('div', undefined, 'display:flex;gap:8px;flex-wrap:wrap;')
      if (e.repairable) {
        const btn = el('button', '修复')
        btn.className = 'pf-btn ghost'
        btn.addEventListener('click', () => void doRepair(e.id))
        actions.appendChild(btn)
      }
      const ai = el('button', state.explain[e.id] === 'loading' ? 'AI 解读中…' : 'AI 解读')
      ai.className = 'pf-btn ghost'
      ai.addEventListener('click', () => void doExplain(e.id))
      actions.appendChild(ai)
      const restore = el('button', '恢复')
      restore.className = 'pf-btn danger'
      restore.addEventListener('click', () => void askRestore(e.id))
      actions.appendChild(restore)
      right.appendChild(actions)
      const st = state.explain[e.id]
      if (st === 'loading') {
        right.appendChild(el('div', 'AI 解读中…（deepseek-v4-flash）', 'font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
      } else if (typeof st === 'string') {
        right.appendChild(el('div', `AI 解读 · 仅供参考`, 'font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:4px;'))
        right.appendChild(el('div', st, 'font-size:12.5px;white-space:pre-wrap;border:1px solid var(--dsw-alias-brand-primary-new-color,#4176e6);border-radius:12px;padding:12px 14px;'))
      }
      right.appendChild(el('div', '恢复 / 修复只改 patch 文件与台账，重启 dsh 后生效。', 'font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
    }
    wrap.appendChild(right)
    root.appendChild(wrap)
  }

  async function runDoctor(): Promise<void> {
    if (state.doctor === 'running') return
    state.doctor = 'running'
    state.doctorError = null
    render()
    try {
      const r = await invoke<{ checks: DoctorCheck[] }>('run_doctor')
      state.doctor = r.checks
      console.info('[plugin-fuse] run_doctor 完成：', Array.isArray(r.checks) ? `${r.checks.length} 项` : JSON.stringify(r))
    } catch (err) {
      state.doctor = 'idle'
      state.doctorError = String(err)
      // 错误必须可观测：console 镜像会把这条写进 ~/.dsh/dsh-desktop-webview.log
      console.error('[plugin-fuse] run_doctor 失败：', err)
      root.appendChild(el('div', `体检失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
    render()
  }

  async function doRepair(id: string): Promise<void> {
    try {
      const r = await invoke<{ ok: boolean; message?: string; error?: string }>('repair_plugin', { id })
      root.appendChild(el('div', r.ok ? `修复完成：${r.message ?? ''}` : `修复失败：${r.error ?? ''}`, `font-size:12px;color:${r.ok ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-state-danger-primary,#e5534b)'};`))
    } catch (err) {
      root.appendChild(el('div', `修复失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
    await reload()
    render()
  }

  async function doExplain(id: string): Promise<void> {
    if (state.explain[id] === 'loading') return
    state.explain[id] = 'loading'
    render()
    try {
      const r = await invoke<{ ok: boolean; suggestion?: string; error?: string }>('explain_failure', { id })
      state.explain[id] = r.ok && r.suggestion ? r.suggestion : `AI 解读不可用：${r.error ?? '未知'}`
    } catch (err) {
      state.explain[id] = `AI 解读不可用：${String(err)}`
    }
    render()
  }

  async function askRestore(id: string): Promise<void> {
    if (!window.confirm(`恢复 ${id}？\n\n将从 cordis.patch.yml 托管区块移除 disabled: true 行，恢复后将在下次重启时生效。若新版本 dsh 仍不兼容，下次启动会再次被自动隔离。`)) return
    try {
      await invoke('restore_quarantine', { ids: [id] })
      await reload()
      render()
    } catch (err) {
      root.appendChild(el('div', `恢复失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
  }

  async function saveSettings(): Promise<void> {
    if (!state.settings) return
    try {
      await invoke('save_quarantine_settings', {
        firstPartyProtection: state.settings.first_party_protection,
        exclude: state.settings.exclude,
        maxRetries: state.settings.max_retries,
      })
    } catch (err) {
      root.appendChild(el('div', `设置保存失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
    render()
  }

  void (async () => {
    await Promise.all([reload(), loadSummary()])
    try {
      state.settings = await invoke<FuseSettings>('get_quarantine_settings')
    } catch {
      state.settings = { first_party_protection: true, exclude: [], max_retries: 2 }
    }
    render()
  })()
  render()
  return root
}
