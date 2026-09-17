// blob:/data: 下载拦截器（#72）。
//
// WKWebView 无法把 blob:/data: 的下载内容交给原生层，wry 的 on_download 只能
// 拿到 URL 而拿不到内存态数据——所以在页面侧拦截（capture 阶段抢在默认行为
// 前 preventDefault），用 fetch 拿到内容后经 Tauri IPC 分块交 Rust 写盘。
// http(s) 下载不拦（走 on_download → Rust 下载管理器直连转交）。
// 纯浏览器（无 Tauri IPC）不装，保持浏览器原生下载行为。
//
// 保存框是异步的：start_blob_download 返回任务 id 时用户尚未选完路径，
// 需轮询 list_downloads 等待状态变为 downloading（或被取消即中止）。

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

interface InterceptTask {
  id: number
  status: string
}

/** 拦截判定（纯函数，供测试）：仅 blob:/data: 协议的 a[download] 点击才接管。 */
export function shouldIntercept(href: string | null, hasDownloadAttr: boolean): boolean {
  if (!hasDownloadAttr || href === null) return false
  return /^blob:/i.test(href) || /^data:/i.test(href)
}

/** 从拦截的 anchor 推断文件名：download 属性优先，回退 URL 尾段。 */
export function filenameFromAnchor(downloadAttr: string | null, href: string): string {
  const fromAttr = (downloadAttr ?? '').trim()
  if (fromAttr !== '') return fromAttr
  if (/^data:/i.test(href)) return 'download' // data URL 的 pathname 不是文件路径，直接默认名
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined
    const u = new URL(href, base)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last ?? 'download'
  } catch {
    return 'download'
  }
}

/** 分块大小：512KB（IPC payload 与内存的平衡点）。 */
const CHUNK_BYTES = 512 * 1024

/** ArrayBuffer → base64（分段 btoa，避免大数组 String.fromCharCode 栈溢出）。 */
function base64Of(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const SEG = 0x8000
  for (let i = 0; i < bytes.length; i += SEG) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SEG))
  }
  return btoa(bin)
}

/** 等待保存框结束：任务状态离开 choosing_path（downloading=继续，其它=中止）。 */
async function waitPathChosen(id: number, signal: { aborted: boolean }): Promise<boolean> {
  for (let i = 0; i < 600; i++) {
    if (signal.aborted) return false
    try {
      const tasks = await invoke<InterceptTask[]>('list_downloads')
      const t = tasks.find((x) => x.id === id)
      if (t === undefined) return false
      if (t.status === 'downloading') return true
      if (t.status !== 'choosing_path') return false // cancelled 等终态
    } catch {
      return false
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** 安装拦截器（幂等）。仅在桌面壳 webview（有 Tauri IPC）生效。 */
export function installDownloadInterceptor(): void {
  if (!hasIpc()) return
  if ((window as unknown as { __dshDownloadsIntercept?: boolean }).__dshDownloadsIntercept === true) return
  ;(window as unknown as { __dshDownloadsIntercept?: boolean }).__dshDownloadsIntercept = true

  document.addEventListener(
    'click',
    (ev) => {
      if (ev.defaultPrevented) return
      const target = ev.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (anchor === null) return
      const href = anchor.getAttribute('href')
      if (!shouldIntercept(href, anchor.hasAttribute('download'))) return
      ev.preventDefault()
      ev.stopPropagation()
      const filename = filenameFromAnchor(anchor.getAttribute('download'), href ?? '')
      void transferBlobToShell(href ?? '', filename)
    },
    true,
  )
}

/** blob/data → 分块 IPC → Rust 写盘。任何一步失败都 console.warn（不抛给页面）。 */
async function transferBlobToShell(href: string, filename: string): Promise<void> {
  try {
    const resp = await fetch(href)
    if (!resp.ok) throw new Error(`fetch ${href} -> ${resp.status}`)
    const blob = await resp.blob()
    const id = await invoke<number | null>('start_blob_download', { filename, total: blob.size })
    if (id === null || id === undefined) return
    const signal = { aborted: false }
    if (!(await waitPathChosen(id, signal))) return
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const chunk = blob.slice(offset, offset + CHUNK_BYTES)
      const b64 = base64Of(await chunk.arrayBuffer())
      const ok = await invoke<boolean>('save_blob_chunk', { id, chunk: b64 })
      if (!ok) return // 已暂停/取消：立即停发
    }
    await invoke<boolean>('finish_blob_download', { id })
  } catch (err) {
    console.warn('[dsh-desktop] blob 下载转交失败：', err)
  }
}
