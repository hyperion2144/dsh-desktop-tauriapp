// 桌面设置 Tab：托盘设置能力全部迁移至此。
// 区块：dsh 服务地址 / Profile / 本地端口 / 代理设置（数据走 Tauri IPC，无弹窗）。
import React from 'react'
import type { ClientContext } from './ctx-types.ts'

export const inject = ['slots']

// dsh settings 服务的桌面壳命名空间 RPC 通道（宿主 index.js 注册）。
// 所有设置项持久化走此通道（宿主侧 ctx.settings.get/mutate），不直接读写 settings.yaml；
// Tauri IPC 仅保留只读回显（get_proxy_settings 的 effective 预览、profile 目录扫描）与动作（重启/连通性测试）。
const NS_CHANNEL = '/dsh-desktop-fuse-settings'

let nsRpc: { rpc: { call: (channel: string, endpoint: string, payload?: unknown) => Promise<any> } } | null = null

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

interface DesktopData {
  remote_addr: string | null
  remote_list: string[]
  port: number
  profiles: Array<{ name: string; active: boolean; selectable: boolean }>
}

let stylesInstalled = false
function ensureStyles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  const style = document.createElement('style')
  style.dataset.desktopSettings = 'styles'
  style.textContent = `
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
  document.head.appendChild(style)
}

function DesktopSettingsPanel(): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const host = ref.current
    if (!host || host.childNodes.length) return
    ensureStyles()
    try {
      const root = buildPanel()
      host.appendChild(root)
      void loadAll(root)
    } catch (err) {
      host.appendChild(el('div', `桌面设置面板初始化失败：${String(err)}`, 'color:#e5534b;font-size:12px;'))
    }
    return () => { host.replaceChildren() }
  }, [])
  return React.createElement('div', { ref })
}

async function loadAll(root: HTMLElement): Promise<void> {
  // 由 buildPanel 内部的 doLoad 触发；这里仅占位保证类型完整
  void root
}

function buildPanel(): HTMLElement {
  const root = el('div', undefined, 'display:flex;flex-direction:column;gap:14px;max-width:680px;font-size:13px;')
  root.dataset.desktopSettings = 'panel'

  // ── 状态 ──
  let proxy: ProxySettings = { proxy_mode: 'off', proxy_url: '', no_proxy: '', proxy_user: '', proxy_pass: '' }
  let effective: ProxySettings['effective'] = undefined
  let desktop: DesktopData = { remote_addr: null, remote_list: [], port: 3080, profiles: [] }
  let newRemoteUrl = ''
  let portDraft = ''
  let downloadConcurrency = 3
  let testResult: string | null = null
  let testBusy = false
  let msg: { ok: boolean; text: string } | null = null
  let busy = false

  async function renderSourceInfo(target: HTMLElement): Promise<void> {
    try {
      const s = await invoke<{ mode: string; builtin: { dsh_version: string } | null; external: { dsh_version: string; path: string } | null }>('get_dsh_source')
      const parts: string[] = []
      if (s.builtin) parts.push(`内置 dsh ${s.builtin.dsh_version}`)
      if (s.external) parts.push(`外部 dsh ${s.external.dsh_version}（${s.external.path}）`)
      target.textContent = parts.length ? `当前来源 ${s.mode} · ${parts.join(' | ')}` : '未检测到任何可用 dsh'
    } catch (err) {
      target.textContent = `检测失败：${String(err)}`
    }
  }

  function section(title: string): { box: HTMLElement; body: HTMLElement } {
    const box = el('div', undefined, 'border:1px solid var(--dsw-alias-border-l,#ffffff1f);border-radius:12px;padding:14px 16px;')
    box.appendChild(el('div', title, 'pf-title'))
    return { box, body: box }
  }

  function note(box: HTMLElement, text: string): void {
    box.appendChild(el('div', text, 'pf-note'))
  }

  function render(): void {
    root.replaceChildren()

    // ── dsh 服务地址 ──
    {
      const { box } = section('dsh 服务地址')
      const remoteSel = document.createElement('select')
      remoteSel.style.cssText = 'width:100%;margin-bottom:8px;'
      const localOpt = document.createElement('option')
      localOpt.value = ''
      localOpt.textContent = '本地（127.0.0.1）'
      if (!desktop.remote_addr) localOpt.selected = true
      remoteSel.appendChild(localOpt)
      for (const addr of desktop.remote_list) {
        const o = document.createElement('option')
        o.value = addr
        o.textContent = addr
        if (desktop.remote_addr === addr) o.selected = true
        remoteSel.appendChild(o)
      }
      remoteSel.addEventListener('change', () => void doSelectRemote(remoteSel.value || null))
      box.appendChild(remoteSel)

      // 新增地址行
      const addRow = el('div', undefined, 'display:flex;gap:8px;')
      const addInput = document.createElement('input')
      addInput.placeholder = '新增：dsh web 打印的完整 URL（含 token）或 host[:port]'
      addInput.className = 'pf-input'
      addInput.style.flex = '1'
      addInput.dataset.desktopSettings = 'remote-add'
      addInput.addEventListener('change', () => { newRemoteUrl = addInput.value.trim() })
      const addBtn = el('button', '新增')
      addBtn.className = 'pf-btn ghost'
      addBtn.addEventListener('click', () => void doAddRemote())
      addRow.append(addInput, addBtn)
      box.appendChild(addRow)

      // 地址删除行
      if (desktop.remote_list.length) {
        const delRow = el('div', undefined, 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;')
        for (const addr of desktop.remote_list) {
          const delBtn = el('button', `删除：${addr}`)
          delBtn.className = 'pf-btn danger'
          delBtn.style.fontSize = '11px'
          delBtn.addEventListener('click', () => void doRemoveRemote(addr))
          delRow.appendChild(delBtn)
        }
        box.appendChild(delRow)
      }
      note(box, '选择远程地址后立即按当前模式重启 dsh；新增/删除仅改列表，重启后生效。')
      root.appendChild(box)
    }

    // ── Profile ──
    {
      const { box } = section('Profile')
      const profSel = document.createElement('select')
      profSel.style.cssText = 'width:100%;margin-bottom:8px;'
      for (const p of desktop.profiles) {
        const o = document.createElement('option')
        o.value = p.name
        o.textContent = p.active ? `✓ ${p.name}` : p.name
        if (p.active) o.selected = true
        profSel.appendChild(o)
      }
      profSel.addEventListener('change', () => void doSwitchProfile(profSel.value))
      box.appendChild(profSel)
      note(box, '切换 Profile 会以目标 profile 重启 dsh web。')
      root.appendChild(box)
    }

    // ── dsh 来源（#90）──
    {
      const { box } = section('dsh 来源')
      const modeSel = document.createElement('select')
      modeSel.style.cssText = 'width:100%;margin-bottom:8px;'
      ;[['builtin', '内置（随应用分发，推荐）'], ['external', '外部（DSH_BIN → PATH → npm 全局）']].forEach(([v, l]) => {
        const o = document.createElement('option')
        o.value = v
        o.textContent = l
        modeSel.appendChild(o)
      })
      const info = el('div', '检测中…', 'pf-note')
      box.appendChild(modeSel)
      box.appendChild(info)
      const refreshBtn = el('button', '重新检测')
      refreshBtn.className = 'pf-btn ghost'
      refreshBtn.addEventListener('click', () => void renderSourceInfo(info))
      box.appendChild(refreshBtn)
      modeSel.addEventListener('change', () => {
        void invoke('set_dsh_source', { mode: modeSel.value })
          .then(() => {
            setMsg(true, `dsh 来源已切换为 ${modeSel.value === 'builtin' ? '内置' : '外部'}；重启 dsh 后生效。`)
            void renderSourceInfo(info)
          })
          .catch((e) => setMsg(false, `设置失败：${String(e)}`))
      })
      note(box, '内置：随应用分发的 dsh 依赖树 + Node，直调内部启动接口（不依赖系统环境）。外部：使用系统安装的 dsh CLI。')
      void renderSourceInfo(info)
    }

    // ── Profile 端口（#90）──
    {
      const { box } = section('Profile 端口')
      const tbl = document.createElement('table')
      tbl.style.cssText = 'width:100%;font-size:12px;border-collapse:collapse;'
      box.appendChild(el('div', '加载中…', 'pf-note'))
      invoke<Array<{ profile: string; port: number; lane_port: number; running: boolean }>>('list_profile_ports')
        .then((rows) => {
          tbl.replaceChildren()
          const head = document.createElement('tr')
          ;['Profile', '启动端口', 'Lane 端口', '状态', ''].forEach((h) => {
            const th = document.createElement('th')
            th.textContent = h
            th.style.textAlign = 'left'
            head.appendChild(th)
          })
          tbl.appendChild(head)
          for (const r of rows) {
            const tr = document.createElement('tr')
            const name = document.createElement('td')
            name.textContent = r.profile
            tr.appendChild(name)
            const portCell = document.createElement('td')
            const portInput = document.createElement('input')
            portInput.placeholder = String(r.port)
            portInput.style.width = '84px'
            portInput.dataset.desktopSettings = `profile-port-${r.profile}`
            const saveBtn = el('button', '保存')
            saveBtn.className = 'pf-btn ghost'
            saveBtn.style.marginLeft = '6px'
            const doSave = () => {
              const v = Number(portInput.value)
              if (!portInput.value || Number.isNaN(v) || v < 1 || v > 65535) return
              invoke('set_profile_port', { profile: r.profile, port: v })
                .then(() => note(box, `${r.profile} 端口已改为 ${v}；重启该 profile 生效。`))
                .catch((e) => note(box, `保存失败：${String(e)}`))
            }
            portInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doSave() })
            saveBtn.addEventListener('click', () => doSave())
            portCell.append(portInput, saveBtn)
            tr.appendChild(portCell)
            const laneCell = document.createElement('td')
            laneCell.textContent = String(r.lane_port)
            tr.appendChild(laneCell)
            const stCell = document.createElement('td')
            stCell.textContent = r.running ? '● 运行中' : '未运行'
            stCell.style.color = r.running ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-label-secondary,#9aa4b2)'
            tr.appendChild(stCell)
            tbl.appendChild(tr)
          }
        })
        .catch(() => {
          tbl.replaceChildren(el('div', '端口表加载失败（无 Tauri IPC？）', 'pf-note'))
        })
      note(box, 'web 固定默认 3080 · desktop 固定默认 3081 · 其余自动分配；lane 同规则错开（3092 起）。改动后重启该 profile 生效。')
      root.appendChild(box)
    }

    // ── 迁移 Profile（#88/#90）──
    {
      const { box } = section('迁移 Profile')
      box.appendChild(el('div', '源 profile → 目标 profile（全量复制；目标已存在需覆盖确认）', 'pf-label'))
      const row = el('div', undefined, 'display:flex;gap:8px;')
      const srcSel = document.createElement('select')
      srcSel.style.cssText = 'flex:1;'
      for (const p of desktop.profiles) {
        const o = document.createElement('option')
        o.value = p.name
        o.textContent = p.name
        srcSel.appendChild(o)
      }
      const dstInput = document.createElement('input')
      dstInput.placeholder = '目标名称'
      dstInput.className = 'pf-input'
      dstInput.style.flex = '1'
      dstInput.dataset.desktopSettings = 'migrate-dest'
      const migBtn = el('button', '迁移…')
      migBtn.className = 'pf-btn ghost'
      migBtn.addEventListener('click', () => {
        const dest = dstInput.value.trim()
        if (!dest) { setMsg(false, '请输入目标 profile 名称'); render(); return }
        void invoke<string>('migrate_profile', { source: srcSel.value, dest, overwrite: false })
          .then((s) => { setMsg(true, s); dstInput.value = '' })
          .catch((e) => {
            const msg = String(e)
            if (msg.includes('需确认覆盖')) {
              void invoke<string>('migrate_profile', { source: srcSel.value, dest, overwrite: true })
                .then((s) => { setMsg(true, s); dstInput.value = '' })
                .catch((e2) => setMsg(false, `迁移失败：${String(e2)}`))
            } else {
              setMsg(false, `迁移失败：${msg}`)
            }
          })
          .finally(() => render())
      })
      row.append(srcSel, dstInput, migBtn)
      box.appendChild(row)
      note(box, '源为当前运行中的 profile 时会先停止其实例；外部实例在跑则拒绝。目标为激活 profile 时拒绝迁移。')
      root.appendChild(box)
    }

    // ── 本地端口 ──
    // ── 本地端口 ──
    {
      const { box } = section('本地端口')
      const row = el('div', undefined, 'display:flex;gap:8px;align-items:center;')
      const portInput = document.createElement('input')
      portInput.placeholder = `当前 ${desktop.port}`
      portInput.value = portDraft
      portInput.style.width = '140px'
      portInput.dataset.desktopSettings = 'port'
      portInput.addEventListener('change', () => { portDraft = portInput.value.trim() })
      const portBtn = el('button', '保存端口')
      portBtn.className = 'pf-btn ghost'
      portBtn.addEventListener('click', () => void doSavePort())
      row.append(portInput, portBtn)
      box.appendChild(row)
      note(box, '改动后需重启 dsh 生效（可用托盘「重启 dsh 服务」）。')
      root.appendChild(box)
    }

    // ── 下载（#72）──
    {
      const { box } = section('下载')
      const row = el('div', undefined, 'display:flex;gap:8px;align-items:center;')
      const concInput = document.createElement('input')
      concInput.placeholder = '1-32'
      invoke<{ concurrency: number }>('get_download_settings')
        .then((s) => {
          downloadConcurrency = s.concurrency
          if (concInput.dataset.userTouched !== '1') concInput.value = String(s.concurrency)
        })
        .catch(() => {})
      concInput.dataset.desktopSettings = 'load-concurrency'
      concInput.value = String(downloadConcurrency)
      concInput.style.width = '80px'
      concInput.dataset.desktopSettings = 'download-concurrency'
      const concBtn = el('button', '保存')
      concBtn.className = 'pf-btn ghost'
      concBtn.addEventListener('click', () => {
        const v = Math.max(1, Math.min(32, parseInt(concInput.value, 10) || 3))
        invoke('set_download_concurrency', { value: v })
          .then(() => { downloadConcurrency = v; note(box, `已保存：并发上限 ${v}`) })
          .catch(() => note(box, '保存失败（无 Tauri IPC？）'))
      })
      row.append(concInput, concBtn)
      box.appendChild(row)
      note(box, '同时进行的下载数上限，超出排队；改动立即生效。')
      root.appendChild(box)
    }
    // ── 代理设置 ──
    {
      const { box } = section('代理设置')
      box.appendChild(el('div', '代理模式', 'pf-label'))
      const modeSel = document.createElement('select')
      modeSel.style.cssText = 'width:100%;margin-bottom:10px;'
      ;[['off', '不使用代理'], ['system', '跟随系统代理'], ['manual', '手动指定代理']].forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l
        if (v === proxy.proxy_mode) o.selected = true
        modeSel.appendChild(o)
      })
      modeSel.addEventListener('change', () => { proxy.proxy_mode = modeSel.value; render() })
      box.appendChild(modeSel)

      if (proxy.proxy_mode === 'manual') {
        box.appendChild(el('div', '代理 URL', 'pf-label'))
        const urlInput = document.createElement('input')
        urlInput.placeholder = 'http/https/socks5://host:port'
        urlInput.value = proxy.proxy_url
        urlInput.className = 'pf-input'
        urlInput.dataset.desktopSettings = 'proxy-url'
        urlInput.addEventListener('change', () => { proxy.proxy_url = urlInput.value.trim() })
        box.appendChild(urlInput)
      }
      if (proxy.proxy_mode === 'manual' || proxy.proxy_mode === 'system') {
        box.appendChild(el('div', 'NO_PROXY（不走代理的地址，逗号分隔）', 'pf-label'))
        const npInput = document.createElement('input')
        npInput.placeholder = 'localhost,127.0.0.1,*.internal'
        npInput.value = proxy.no_proxy
        npInput.className = 'pf-input'
        npInput.dataset.desktopSettings = 'no-proxy'
        npInput.addEventListener('change', () => { proxy.no_proxy = npInput.value.trim() })
        box.appendChild(npInput)

        const authRow = el('div', undefined, 'display:flex;gap:8px;margin-top:8px;')
        const userWrap = el('div', undefined, 'flex:1;')
        userWrap.appendChild(el('div', '用户名（可选）', 'pf-label'))
        const userInput = document.createElement('input')
        userInput.value = proxy.proxy_user
        userInput.className = 'pf-input'
        userInput.dataset.desktopSettings = 'proxy-user'
        userInput.addEventListener('change', () => { proxy.proxy_user = userInput.value })
        userWrap.appendChild(userInput)
        const passWrap = el('div', undefined, 'flex:1;')
        passWrap.appendChild(el('div', '密码（可选）', 'pf-label'))
        const passInput = document.createElement('input')
        passInput.type = 'password'
        passInput.value = proxy.proxy_pass
        passInput.className = 'pf-input'
        passInput.dataset.desktopSettings = 'proxy-pass'
        passInput.addEventListener('change', () => { proxy.proxy_pass = passInput.value })
        passWrap.appendChild(passInput)
        authRow.append(userWrap, passWrap)
        box.appendChild(authRow)
      }

      if (effective) {
        box.appendChild(el('div', `当前生效：${JSON.stringify(effective)}`, 'pf-note'))
      }
      if (proxy.proxy_mode === 'manual' && proxy.proxy_url) {
        const testBtn = el('button', testBusy ? '测试中…' : '测试连接')
        testBtn.className = 'pf-btn ghost'
        testBtn.style.marginTop = '8px'
        testBtn.addEventListener('click', () => void doTest())
        box.appendChild(testBtn)
        if (testResult) box.appendChild(el('div', testResult, 'pf-note'))
      }
      root.appendChild(box)
    }

    // ── 保存（代理）──
    const saveBtn = el('button', busy ? '保存中…' : '保存代理设置')
    saveBtn.className = 'pf-btn'
    saveBtn.style.marginTop = '4px'
    saveBtn.addEventListener('click', () => void doSave())
    root.appendChild(saveBtn)

    if (msg) {
      root.appendChild(el('div', msg.text, `font-size:12px;color:${msg.ok ? 'var(--dsw-alias-state-success-primary,#2fbf71)' : 'var(--dsw-alias-state-danger-primary,#e5534b)'};`))
    }
    root.appendChild(el('div', '服务地址/Profile 切换会立即重启 dsh；端口与代理在下次重启后生效。', 'pf-note'))
  }

  function setMsg(ok: boolean, text: string): void {
    msg = { ok, text }
  }

  async function nsSave(patch: Record<string, unknown>): Promise<void> {
    if (!nsRpc) throw new Error('dsh settings 通道不可用（需桌面壳环境）')
    const r = await nsRpc.rpc.call(NS_CHANNEL, 'save', { patch })
    if (!r?.ok) throw new Error(r?.error?.message ?? '保存被拒绝')
  }

  async function nsGet(): Promise<Record<string, unknown>> {
    if (!nsRpc) throw new Error('dsh settings 通道不可用（需桌面壳环境）')
    const r = await nsRpc.rpc.call(NS_CHANNEL, 'get', {})
    if (!r?.ok) throw new Error(r?.error?.message ?? '读取被拒绝')
    return (r.value && typeof r.value === 'object' ? r.value : {}) as Record<string, unknown>
  }

  async function doLoad(): Promise<void> {
    try {
      const [ns, p, d] = await Promise.all([
        nsGet(),
        invoke<ProxySettings>('get_proxy_settings'),
        invoke<DesktopData>('get_desktop_settings_data'),
      ])
      proxy = {
        proxy_mode: (ns.proxy_mode as string) || p.proxy_mode || 'off',
        proxy_url: (ns.proxy_url as string) || p.proxy_url || '',
        no_proxy: (ns.no_proxy as string) || p.no_proxy || '',
        proxy_user: (ns.proxy_user as string) || p.proxy_user || '',
        proxy_pass: (ns.proxy_pass as string) || p.proxy_pass || '',
      }
      effective = p.effective
      desktop = {
        remote_addr: (ns.remote_addr as string | null) ?? null,
        remote_list: (ns.remote_list as string[]) ?? d.remote_list ?? [],
        port: (ns.port as number) || d.port || 3080,
        profiles: d.profiles,
      }
      portDraft = ''
    } catch (err) {
      setMsg(false, `读取设置失败：${String(err)}`)
    }
    render()
  }

  async function doSave(): Promise<void> {
    if (busy) return
    busy = true; render()
    try {
      await nsSave({
        proxy_mode: proxy.proxy_mode,
        proxy_url: proxy.proxy_url,
        no_proxy: proxy.no_proxy,
        proxy_user: proxy.proxy_user,
        proxy_pass: proxy.proxy_pass,
      })
      setMsg(true, '代理设置已保存；下次 dsh 重启后生效。')
    } catch (err) {
      setMsg(false, `保存失败：${String(err)}`)
    }
    busy = false
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

  async function doSelectRemote(addr: string | null): Promise<void> {
    try {
      await nsSave({ remote_addr: addr })
      await invoke('restart_dsh_service')
      setMsg(true, '已切换 dsh 服务来源，正在重启…')
    } catch (err) {
      setMsg(false, `切换失败：${String(err)}`)
    }
    render()
  }

  // 地址归一化（对齐 Rust normalize_remote_url 核心规则）：完整 URL 或 host[:port]
  function normalizeRemote(input: string): string | null {
    const t = input.trim()
    if (!t) return null
    if (/^https?:\/\//.test(t)) return t
    if (/^socks5:\/\//.test(t)) return t
    if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(t)) return `https://${t}`
    return null
  }

  async function doAddRemote(): Promise<void> {
    const addr = normalizeRemote(newRemoteUrl)
    if (!addr) { setMsg(false, '地址非法：需 dsh web 完整 URL（含 token）或 host[:port]'); render(); return }
    try {
      const list = Array.isArray(desktop.remote_list) ? [...desktop.remote_list] : []
      if (!list.includes(addr)) list.push(addr)
      await nsSave({ remote_list: list })
      newRemoteUrl = ''
      setMsg(true, `已新增地址：${addr}（未切换，请在下拉框选择）`)
    } catch (err) {
      setMsg(false, `新增失败：${String(err)}`)
    }
    await refreshData()
  }

  async function doRemoveRemote(addr: string): Promise<void> {
    try {
      const list = (desktop.remote_list ?? []).filter((a) => a !== addr)
      const patch: Record<string, unknown> = { remote_list: list }
      if (desktop.remote_addr === addr) patch.remote_addr = null
      await nsSave(patch)
      setMsg(true, `已删除：${addr}`)
    } catch (err) {
      setMsg(false, `删除失败：${String(err)}`)
    }
    await refreshData()
  }

  async function doSwitchProfile(name: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { setMsg(false, 'Profile 名不合法'); render(); return }
    try {
      await nsSave({ active_profile: name })
      await invoke('restart_dsh_service')
      setMsg(true, `已切换到 Profile「${name}」，正在重启…`)
    } catch (err) {
      setMsg(false, `切换 Profile 失败：${String(err)}`)
    }
    render()
  }

  async function doSavePort(): Promise<void> {
    const port = Number(portDraft)
    if (!portDraft || Number.isNaN(port) || port < 1 || port > 65535) { setMsg(false, '请输入 1-65535 的有效端口'); render(); return }
    try {
      await nsSave({ port })
      portDraft = ''
      setMsg(true, `端口已改为 ${port}；重启 dsh 后生效。`)
    } catch (err) {
      setMsg(false, `设置端口失败：${String(err)}`)
    }
    await refreshData()
  }

  async function refreshData(): Promise<void> {
    try {
      desktop = await invoke<DesktopData>('get_desktop_settings_data')
    } catch { /* 保留旧数据 */ }
    render()
  }

  void doLoad()
  render()
  return root
}

export function registerDesktopSettings(ctx: ClientContext): void {
  if (!hasIpc()) return
  // 捕获 connection RPC（dsh settings 服务的桌面壳命名空间读写通道）
  try {
    nsRpc = (ctx as unknown as { connection?: { rpc: { call: (c: string, e: string, p?: unknown) => Promise<any> } } }).connection ?? null
  } catch { nsRpc = null }
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
