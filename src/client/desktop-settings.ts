// 桌面设置 Tab：托盘设置能力全部迁移至此（代理/手机访问/AI 路由）。
// settings.section 注入（同保险丝/远程访问），数据走 Tauri IPC。
import React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['slots']

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

function el(tag: string, text?: string, style?: string): HTMLElement {
  const e = document.createElement(tag)
  if (text != null) e.textContent = text
  if (style) e.style.cssText = style
  return e
}

interface ProxySettings {
  proxy_mode: string
  proxy_url: string
  no_proxy: string
  proxy_user: string
  proxy_pass: string
  effective?: { http?: string; https?: string; all?: string; no_proxy?: string }
}

let stylesInstalled = false
function ensureStyles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  const style = document.createElement('style')
  style.dataset.desktopSettings = '1'
  style.textContent = `
[data-desktop-settings] .pf-btn { background:var(--dsw-alias-brand-primary-new-color,#4176e6); border:none; color:#fff; border-radius:8px; padding:6px 13px; font-size:12px; cursor:pointer; transition:filter .12s, transform .06s; }
[data-desktop-settings] .pf-btn:hover { filter:brightness(1.12); }
[data-desktop-settings] .pf-btn:active { transform:translateY(1px); }
[data-desktop-settings] .pf-btn.ghost { background:transparent; border:1px solid var(--dsw-alias-border-l,#ffffff1f); color:var(--dsw-alias-label-primary,#e7eaf0); }
[data-desktop-settings] .pf-btn.ghost:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)); filter:none; }
[data-desktop-settings] .pf-btn.ghost:active { background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12)); transform:translateY(1px); filter:none; }
[data-desktop-settings] input, [data-desktop-settings] select { padding:6px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l,#ffffff1f); background:var(--dsw-alias-bg-base,#151517); color:inherit; font-size:12px; }
[data-desktop-settings] .pf-field { margin-bottom:10px; }
[data-desktop-settings] .pf-label { font-size:11px; color:var(--dsw-alias-label-secondary,#9aa4b2); margin-bottom:4px; }
[data-desktop-settings] .pf-input { width:100%; box-sizing:border-box; }
[data-desktop-settings] .pf-section { border:1px solid var(--dsw-alias-border-l,#ffffff1f); border-radius:12px; padding:14px 16px; margin-bottom:14px; }
[data-desktop-settings] .pf-section-title { font-weight:600; font-size:13px; margin-bottom:10px; }
[data-desktop-settings] .pf-result { font-size:12px; margin-top:6px; word-break:break-all; }
`
  document.head.appendChild(style)
}

function DesktopSettingsPanel(): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const host = ref.current
    if (!host || host.childNodes.length) return
    ensureStyles()
    try {
      host.appendChild(buildPanel())
    } catch (err) {
      host.appendChild(el('div', `桌面设置面板初始化失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
    return () => { host.replaceChildren() }
  }, [])
  return React.createElement('div', { ref })
}

function buildPanel(): HTMLElement {
  const root = el('div', undefined, 'display:flex;flex-direction:column;gap:14px;max-width:680px;font-size:13px;')
  root.dataset.desktopSettings = '1'

  // ── 状态 ──
  let proxy: ProxySettings = { proxy_mode: 'off', proxy_url: '', no_proxy: '', proxy_user: '', proxy_pass: '' }
  let effective: ProxySettings['effective'] = undefined
  let testResult: string | null = null
  let testBusy = false
  let saveMsg: string | null = null
  let saveOk = false

  function render(): void {
    root.replaceChildren()

    // ── 代理设置 ──
    const proxySection = el('div', undefined, 'border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:14px 16px;')
    proxySection.appendChild(el('div', '代理设置', 'font-weight:600;font-size:13px;margin-bottom:10px;'))

    // mode dropdown
    const modeLabel = el('div', '代理模式', 'font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:4px;')
    proxySection.appendChild(modeLabel)
    const modeSel = document.createElement('select')
    modeSel.style.cssText = 'width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:inherit;font-size:12px;margin-bottom:10px;'
    ;[['off', '不使用代理'], ['system', '跟随系统代理'], ['manual', '手动指定代理']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l
      if (v === proxy.proxy_mode) o.selected = true
      modeSel.appendChild(o)
    })
    modeSel.addEventListener('change', () => { proxy.proxy_mode = modeSel.value; render() })
    proxySection.appendChild(modeSel)

    // manual fields (shown when mode=manual)
    // URL 仅 manual 模式显示；认证字段 system + manual 都显示
    if (proxy.proxy_mode === 'manual') {
      proxySection.appendChild(el('div', '代理 URL', 'font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:4px;'))
      const urlInput = document.createElement('input')
      urlInput.placeholder = 'http/https/socks5://host:port'
      urlInput.value = proxy.proxy_url
      urlInput.className = 'pf-input'
      urlInput.dataset.desktopSettings = '1'
      urlInput.addEventListener('change', () => { proxy.proxy_url = urlInput.value.trim() })
      proxySection.appendChild(urlInput)
    }
      const passWrap = el('div', undefined, 'flex:1;')
      passWrap.appendChild(el('div', '密码（可选）', 'font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:4px;'))
      const passInput = document.createElement('input')
      passInput.type = 'password'
      passInput.value = proxy.proxy_pass
      passInput.className = 'pf-input'
      passInput.dataset.desktopSettings = '1'
      passInput.addEventListener('change', () => { proxy.proxy_pass = passInput.value })
      passWrap.appendChild(passInput)
      authRow.append(userWrap, passWrap)
      proxySection.appendChild(authRow)
    }

    // effective preview
    if (effective) {
      const eff = typeof effective === 'object' ? JSON.stringify(effective, null, 1) : String(effective)
      proxySection.appendChild(el('div', `当前生效：${eff}`, 'font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-top:8px;word-break:break-all;'))
    }

    // test button (manual mode only)
    if (proxy.proxy_mode === 'manual' && proxy.proxy_url) {
      const testBtn = el('button', testBusy ? '测试中…' : '测试连接')
      testBtn.className = 'pf-btn ghost'
      testBtn.style.marginTop = '8px'
      testBtn.addEventListener('click', () => void doTest())
      proxySection.appendChild(testBtn)
      if (testResult) proxySection.appendChild(el('div', testResult, 'font-size:12px;margin-top:6px;'))
    }
    root.appendChild(proxySection)

    // save button
    const saveBtn = el('button', '保存设置')
    saveBtn.style.marginTop = '4px'
    saveBtn.addEventListener('click', () => void doSave())
    root.appendChild(saveBtn)
    if (saveMsg) {
      root.appendChild(el('div', saveMsg, `font-size:12px;margin-top:6px;color:${saveOk ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-state-danger-primary,#e5534b)'};`))
    }

    // hint
    root.appendChild(el('div', '设置保存到 settings.yaml 的 dsh-desktop-tauriapp: 键；代理/端口等在下次 dsh 重启后生效。', 'font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);'))
  }

  async function doLoad(): Promise<void> {
    try {
      const r = await invoke<ProxySettings>('get_proxy_settings')
      proxy = { proxy_mode: r.proxy_mode || 'off', proxy_url: r.proxy_url || '', no_proxy: r.no_proxy || '', proxy_user: r.proxy_user || '', proxy_pass: r.proxy_pass || '' }
      effective = r.effective
    } catch (err) {
      root.appendChild(el('div', `读取代理设置失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
    render()
  }

  async function doSave(): Promise<void> {
    try {
      await invoke('save_proxy_settings', {
        proxyMode: proxy.proxy_mode,
        proxyUrl: proxy.proxy_url,
        noProxy: proxy.no_proxy,
        proxyUser: proxy.proxy_user,
        proxyPass: proxy.proxy_pass,
      })
      saveMsg = '设置已保存；代理在下次 dsh 重启后生效。'
      saveOk = true
    } catch (err) {
      saveMsg = `保存失败：${String(err)}`
      saveOk = false
    }
    render()
  }

  async function doTest(): Promise<void> {
    if (testBusy) return
    testBusy = true; testResult = null; render()
    try {
      const ms = await invoke<number>('test_proxy_connectivity', { url: proxy.proxy_url })
      testResult = `连接成功（${ms}ms）`
    } catch (err) {
      testResult = `连接失败：${String(err)}`
    }
    testBusy = false
    render()
  }

  void doLoad()
  render()
  return root
}

export function registerDesktopSettings(ctx: ClientContext): void {
  if (!hasIpc()) return
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
}
