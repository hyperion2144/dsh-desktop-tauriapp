/**
 * 桌面档（desktop:<os>）快捷键桥（#187）。
 *
 * dsh 的 client-shortcuts 有两档键盘实现：
 * - web 档：DOM 冒泡阶段自己派发按键（纯浏览器里 dsh 快捷键本来就能用）；
 * - desktop 档：`document.documentElement.dataset.platform` 存在时启用，构造期要求
 *   `window.dshDesktop.keyboard`（缺失即 throw "Desktop keyboard bridge unavailable"），
 *   按键改由「原生桥」喂 `DesktopShortcutInput`（DOM 派发被 `if (native) return` 短路），
 *   偏好改读 `window.dshDesktop.shortcuts`（缺失即 status:'unreadable'，只能只读默认绑定）。
 *
 * 壳此前两者都没提供 → dsh 在桌面窗口里恒落 web 档，`desktop:macos` / `desktop:windows`
 * 的默认绑定（例如 Inspector 的 Ctrl/Cmd+Shift+.）在桌面窗口里没有生效路径。本文件补上
 * 「原生桥」的页面侧实现：
 *
 * - 按键：window 捕获层的 keydown/keyup 状态机（修饰键集合 + 双键重叠 + 顺序无关），
 *   只在「完整组合命中 dsh 当前目录（catalog）里的某个可吞绑定」时吞掉事件，并按桌面
 *   输入形状转发给 dsh 的原生键盘监听者；
 * - 偏好：`$DSH_HOME/desktop-keybindings.json` 读写适配器（Tauri IPC）
 *   实现 dsh 的 DesktopShortcutsApi（get / edit / subscribe / recording）；
 * - 关窗：`closeWindow(revision)` 只在自己仍是最新配置时关（隐藏）当前窗口。
 *
 * Rust 侧载体（desktop/src-tauri/src/ui/browser_guests/mod.rs 的
 * DESKTOP_CARRIER_INIT_SCRIPT）在 document-start 写 platform 标记，并挂
 * `dshDesktop.keyboard` / `dshDesktop.shortcuts` 的惰性转发桩——dsh 在 client 插件构造期
 * 就会取用它们，而真实实现要等本模块装载，所以桩必须自己等实现出现。
 *
 * 已知不覆盖：Windows 无本机编译目标（靠 CI 静态把关）；被系统/WebView 先消费的组合
 * （⌘Q、⌘W 等）拿不到；iframe / guest webview 内的按键不在本捕获层内；壳不做绑定冲突
 * 拦截（冲突仍由 dsh 目录自己标记为 disabled）。
 */

import type { ClientContext } from './ctx-types.ts'

// ── dsh 侧契约（照抄 @deepseek-ai/dsh-client-shortcuts 的 lib/types，避免依赖运行时包）──

export type ShortcutModifier = 'control' | 'alt' | 'shift' | 'meta'

export interface NormalizedBinding {
  code: string
  secondCode?: string
  modifiers: readonly ShortcutModifier[]
}

/** dsh catalog 里的一行（只取本桥用得到的字段）。 */
export interface ShortcutCatalogEntryLike {
  id: string
  binding?: NormalizedBinding | null
  issue?: string | null
  conflicts?: readonly string[]
}

export interface ShortcutGesture {
  code: string
  secondCode?: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  repeat: boolean
}

export interface ShortcutDocument {
  schemaVersion: number
  profiles: Record<string, Record<string, unknown>>
}

export interface ShortcutConfigSnapshot {
  revision: string
  sequence: number
  document: ShortcutDocument
  status: 'loading' | 'ready' | 'unreadable'
  error: 'read' | 'invalid' | 'future' | null
  usingDefaults: boolean
}

export type ShortcutSaveStatus =
  | 'saved'
  | 'stale'
  | 'unreadable'
  | 'write-failed'
  | 'not-ready'
  | 'conflict'

export interface ShortcutSaveResult {
  status: ShortcutSaveStatus
  snapshot: ShortcutConfigSnapshot
  issue?: string
  conflicts?: readonly string[]
}

export type ShortcutEdit =
  | { type: 'set'; id: string; binding: NormalizedBinding }
  | { type: 'reset'; id: string }
  | { type: 'reset-all' }

/** dsh 的 DesktopShortcutInput（kind:'keyboard' 分支）。 */
export interface DesktopShortcutInput {
  revision: string
  kind: 'keyboard'
  frameName: string
  code: string
  secondCode?: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  repeat: boolean
}

/** dsh 侧 ShortcutsService 里本桥用到的面。 */
interface ShortcutsServiceLike {
  runtime?: string
  platform?: string
  catalog?: { getSnapshot(): readonly ShortcutCatalogEntryLike[] }
  config?: { getSnapshot(): ShortcutConfigSnapshot }
}

/** 壳全局载体上的真实实现（Rust 注入的桩会转发到这里）。 */
export interface DesktopKeyboardBridgeImpl {
  subscribeInput(listener: (input: DesktopShortcutInput) => void): () => void
  closeWindow(revision: string): Promise<void>
  get(definitions: unknown): Promise<ShortcutConfigSnapshot>
  edit(edit: ShortcutEdit, revision: string): Promise<ShortcutSaveResult>
  subscribeConfig(listener: (snapshot: ShortcutConfigSnapshot) => void): () => void
  recording(active: boolean): Promise<void>
}

/** dsh 当前支持的 keybindings schemaVersion（>2 视为「未来版本」，只读不写）。 */
export const SHORTCUT_SCHEMA_VERSION = 2

const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'MetaLeft',
  'MetaRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
])

const MODIFIER_ORDER: readonly ShortcutModifier[] = ['control', 'alt', 'shift', 'meta']

// ── 纯函数（scripts/test-client.mjs 直接断言这些）──

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

export function gestureModifiers(gesture: ShortcutGesture): ShortcutModifier[] {
  const modifiers: ShortcutModifier[] = []
  if (gesture.control) modifiers.push('control')
  if (gesture.alt) modifiers.push('alt')
  if (gesture.shift) modifiers.push('shift')
  if (gesture.meta) modifiers.push('meta')
  return modifiers
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item) => b.includes(item))
}

/**
 * 命中判定：绑定存在且有效（无 issue、无冲突）+ 修饰键集合相等 + 键位集合相等（顺序无关）。
 * 与 dsh 的 `bindingKey`（修饰键按 control/alt/shift/meta 排序后拼 code 集合）等价。
 */
export function matchBinding(row: ShortcutCatalogEntryLike, gesture: ShortcutGesture): boolean {
  const binding = row.binding
  if (!binding || typeof binding.code !== 'string' || binding.code === '') return false
  if (row.issue) return false
  if (row.conflicts && row.conflicts.length > 0) return false
  const want = Array.isArray(binding.modifiers) ? binding.modifiers : []
  if (!sameSet(want, gestureModifiers(gesture))) return false
  const wantCodes = binding.secondCode ? [binding.code, binding.secondCode] : [binding.code]
  const gotCodes = gesture.secondCode ? [gesture.code, gesture.secondCode] : [gesture.code]
  return sameSet(wantCodes, gotCodes)
}

/**
 * 可吞判定：至少一个修饰键。裸键（F5、方向键、字母键…）绝不吞——否则会吃掉正常输入，
 * 而这些键在 desktop 档下本来就该由 dsh 的 fixed 序列（DOM 冒泡）处理。
 */
export function isConsumable(row: ShortcutCatalogEntryLike): boolean {
  const modifiers = row.binding?.modifiers
  return Array.isArray(modifiers) && modifiers.length > 0
}

/** 在 catalog 里找第一个「命中且可吞」的绑定。 */
export function matchCatalog(
  catalog: readonly ShortcutCatalogEntryLike[],
  gesture: ShortcutGesture,
): ShortcutCatalogEntryLike | undefined {
  for (const row of catalog) {
    if (matchBinding(row, gesture) && isConsumable(row)) return row
  }
  return undefined
}

export function emptyShortcutDocument(): ShortcutDocument {
  return { schemaVersion: 1, profiles: {} }
}

export interface ParsedKeybindings {
  document: ShortcutDocument
  status: 'ready' | 'unreadable'
  error: 'invalid' | 'future' | null
  usingDefaults: boolean
}

/**
 * 解析 keybindings 文件内容（契约对齐 dsh 的 parseShortcutDocument）：
 * - 文件不存在 / 空 → 空文档 + usingDefaults（dsh 补默认绑定，界面显示「默认」）；
 * - JSON 解析失败 → unreadable / invalid（界面只读，绝不覆盖用户的文件）；
 * - schemaVersion 高于支持范围 → unreadable / future（老壳不写坏新文件）；
 * - 其余原样透传（未知顶层字段保留，写回时不丢）。
 */
export function parseShortcutDocument(raw: string | null): ParsedKeybindings {
  if (raw === null || raw.trim() === '') {
    return { document: emptyShortcutDocument(), status: 'ready', error: null, usingDefaults: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { document: emptyShortcutDocument(), status: 'unreadable', error: 'invalid', usingDefaults: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { document: emptyShortcutDocument(), status: 'unreadable', error: 'invalid', usingDefaults: false }
  }
  const candidate = parsed as { schemaVersion?: unknown; profiles?: unknown }
  const version = candidate.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { document: emptyShortcutDocument(), status: 'unreadable', error: 'invalid', usingDefaults: false }
  }
  if (version > SHORTCUT_SCHEMA_VERSION) {
    return { document: emptyShortcutDocument(), status: 'unreadable', error: 'future', usingDefaults: false }
  }
  const profiles =
    typeof candidate.profiles === 'object' && candidate.profiles !== null && !Array.isArray(candidate.profiles)
      ? (candidate.profiles as Record<string, Record<string, unknown>>)
      : {}
  return {
    document: { ...(parsed as ShortcutDocument), schemaVersion: version, profiles },
    status: 'ready',
    error: null,
    usingDefaults: false,
  }
}

function sanitizeBinding(binding: unknown): NormalizedBinding | null {
  if (typeof binding !== 'object' || binding === null) return null
  const raw = binding as { code?: unknown; secondCode?: unknown; modifiers?: unknown }
  if (typeof raw.code !== 'string' || raw.code === '') return null
  const declared = Array.isArray(raw.modifiers) ? (raw.modifiers as readonly unknown[]) : []
  const modifiers = MODIFIER_ORDER.filter((modifier) => declared.includes(modifier))
  const out: NormalizedBinding = { code: raw.code, modifiers }
  if (typeof raw.secondCode === 'string' && raw.secondCode !== '') out.secondCode = raw.secondCode
  return out
}

/**
 * 应用一次编辑（set / reset / reset-all），只动当前 profile 的那张表。
 * 任何一次编辑都把 schemaVersion 抬到 2（dsh 写盘时的做法）；没编辑过的文件原样保留。
 * id / 冲突校验交给 dsh（它只会发自己目录里的 id，冲突由界面标记禁用），这里只做结构防呆。
 */
export function applyShortcutEdit(
  document: ShortcutDocument,
  edit: ShortcutEdit,
  profile: string,
): { ok: boolean; document: ShortcutDocument } {
  const profiles: Record<string, Record<string, unknown>> = { ...(document.profiles ?? {}) }
  if (edit.type === 'reset-all') {
    profiles[profile] = {}
  } else if (edit.type === 'reset') {
    if (typeof edit.id !== 'string' || edit.id === '') return { ok: false, document }
    const current: Record<string, unknown> = { ...(profiles[profile] ?? {}) }
    delete current[edit.id]
    profiles[profile] = current
  } else if (edit.type === 'set') {
    if (typeof edit.id !== 'string' || edit.id === '') return { ok: false, document }
    const binding = sanitizeBinding(edit.binding)
    if (!binding) return { ok: false, document }
    const current: Record<string, unknown> = { ...(profiles[profile] ?? {}) }
    current[edit.id] = binding
    profiles[profile] = current
  } else {
    return { ok: false, document }
  }
  return { ok: true, document: { ...document, schemaVersion: SHORTCUT_SCHEMA_VERSION, profiles } }
}

// ── 壳 IPC ──

interface TauriInternals {
  invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  const internals = w.__TAURI_INTERNALS__
  if (!internals?.invoke) return Promise.reject(new Error('no-tauri-ipc'))
  return internals.invoke(cmd, args, undefined) as Promise<T>
}

function newRevision(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── 按键状态机 ──

class KeyboardEmitter {
  private readonly held = new Set<string>()
  private readonly order: string[] = []
  private readonly listeners = new Set<(input: DesktopShortcutInput) => void>()
  private attached = false
  private recording = false

  constructor(
    private readonly revisionOf: () => string | null,
    private readonly catalogOf: () => readonly ShortcutCatalogEntryLike[],
  ) {}

  attach(): void {
    if (this.attached) return
    this.attached = true
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onReset, true)
    document.addEventListener('visibilitychange', this.onVisibility, true)
    console.info('[desktop] 桌面档快捷键桥已装：按键走 window 捕获层转发给 dsh')
  }

  setRecording(active: boolean): void {
    this.recording = active
    if (active) this.clear()
  }

  subscribe(listener: (input: DesktopShortcutInput) => void): () => void {
    this.listeners.add(listener)
    // dsh 拿到桥后会订阅原生按键输入；这条日志就是「桥接上了」的证据
    console.info('[desktop][probe] dsh 订阅了原生按键输入')
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** dsh 注册了几个原生按键监听者（自检日志用）。 */
  listenerCount(): number {
    return this.listeners.size
  }

  private clear(): void {
    this.held.clear()
    this.order.length = 0
  }

  private readonly onReset = (): void => this.clear()

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.clear()
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const code = event.code
    if (!code) return
    if (!this.held.delete(code)) return
    const index = this.order.indexOf(code)
    if (index >= 0) this.order.splice(index, 1)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // IME 组字中的按键、以及已经按住的重复键（自动重复）都不参与组合判定
    if (event.isComposing || event.keyCode === 229) return
    const code = event.code
    if (!code || this.held.has(code)) return
    this.held.add(code)
    this.order.push(code)
    if (isModifierCode(code)) return
    // 录制绑定期间（设置界面自己收键）不吞也不派发
    if (this.recording) return
    // 别的处理器已经处理过（例如弹层）就不抢
    if (event.defaultPrevented) return
    const gesture = this.gestureFor(code)
    if (!matchCatalog(this.catalogOf(), gesture)) return
    const revision = this.revisionOf()
    if (revision === null) return
    event.preventDefault()
    event.stopPropagation()
    const input: DesktopShortcutInput = {
      revision,
      kind: 'keyboard',
      frameName: '',
      code: gesture.code,
      control: gesture.control,
      alt: gesture.alt,
      shift: gesture.shift,
      meta: gesture.meta,
      repeat: false,
    }
    if (gesture.secondCode) input.secondCode = gesture.secondCode
    for (const listener of [...this.listeners]) {
      try {
        listener(input)
      } catch (error) {
        console.error('[desktop] 快捷键监听者抛错', error)
      }
    }
  }

  /** 组装「当前按住的整组键」的 gesture：code/secondCode 按 dsh 的规范化顺序（字典序）排列。 */
  private gestureFor(code: string): ShortcutGesture {
    const others = this.order.filter((item) => item !== code && !isModifierCode(item))
    const codes = [code, ...others].sort()
    const modifiers = new Set(this.order.filter((item) => isModifierCode(item)))
    const gesture: ShortcutGesture = {
      code: codes[0],
      control: modifiers.has('ControlLeft') || modifiers.has('ControlRight'),
      alt: modifiers.has('AltLeft') || modifiers.has('AltRight'),
      shift: modifiers.has('ShiftLeft') || modifiers.has('ShiftRight'),
      meta: modifiers.has('MetaLeft') || modifiers.has('MetaRight'),
      repeat: false,
    }
    if (codes.length > 1) gesture.secondCode = codes[1]
    return gesture
  }
}

// ── keybindings 偏好适配器（dsh DesktopShortcutsApi）──

class KeybindingAdapter {
  private document: ShortcutDocument = emptyShortcutDocument()
  private status: ShortcutConfigSnapshot['status'] = 'loading'
  private error: ShortcutConfigSnapshot['error'] = null
  private usingDefaults = true
  private sequence = 0
  private revision = newRevision()
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<(snapshot: ShortcutConfigSnapshot) => void>()

  constructor(private readonly profile: string) {}

  snapshot(): ShortcutConfigSnapshot {
    return {
      revision: this.revision,
      sequence: this.sequence,
      document: this.document,
      status: this.status,
      error: this.error,
      usingDefaults: this.usingDefaults,
    }
  }

  /** 首次读取：读盘 → 解析 → 广播。读盘失败按 unreadable/read 降级（dsh 显示只读默认绑定）。 */
  load(): Promise<void> {
    if (!this.loading) this.loading = this.readFile()
    return this.loading
  }

  private async readFile(): Promise<void> {
    try {
      const raw = await tauriInvoke<string | null>('read_desktop_keybindings')
      const text = typeof raw === 'string' ? raw : null
      const parsed = parseShortcutDocument(text)
      this.document = parsed.document
      this.status = parsed.status
      this.error = parsed.error
      this.usingDefaults = parsed.usingDefaults
    } catch (error) {
      console.warn('[desktop] 快捷键偏好读取失败，回落只读默认绑定', error)
      this.status = 'unreadable'
      this.error = 'read'
      this.usingDefaults = true
    }
    this.publish()
  }

  private publish(): void {
    this.sequence += 1
    this.revision = newRevision()
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('[desktop] 快捷键偏好订阅者抛错', error)
      }
    }
  }

  async get(): Promise<ShortcutConfigSnapshot> {
    await this.load()
    return this.snapshot()
  }

  async edit(edit: ShortcutEdit, revision: string): Promise<ShortcutSaveResult> {
    await this.load()
    if (this.status === 'unreadable') return { status: 'unreadable', snapshot: this.snapshot() }
    if (revision !== this.revision) return { status: 'stale', snapshot: this.snapshot() }
    const applied = applyShortcutEdit(this.document, edit, this.profile)
    if (!applied.ok) return { status: 'not-ready', snapshot: this.snapshot() }
    const raw = `${JSON.stringify(applied.document, null, 2)}\n`
    try {
      await tauriInvoke<void>('write_desktop_keybindings', { raw })
    } catch (error) {
      console.error('[desktop] 快捷键偏好写入失败', error)
      return { status: 'write-failed', snapshot: this.snapshot() }
    }
    this.document = applied.document
    this.status = 'ready'
    this.error = null
    this.usingDefaults = false
    this.publish()
    return { status: 'saved', snapshot: this.snapshot() }
  }

  subscribe(listener: (snapshot: ShortcutConfigSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

// ── 装配 ──

/**
 * 取 dsh 的 shortcuts 服务。
 *
 * 注意：cordis 里 `ctx.shortcuts` 这种属性访问**要求当前上下文声明过该 inject**，
 * 没声明会直接抛 `cannot get property "shortcuts" without inject`（#188 实测：这句话曾让
 * 整个插件的 client 半在 apply 阶段报错、页面 boot 报 `dsh-desktop-tauriapp: failed`）。
 * 所以这里走 ctx.get() 查服务，并对老实现再兜一层 try/catch。
 */
function readService(ctx: ClientContext | undefined): ShortcutsServiceLike | undefined {
  if (!ctx) return undefined
  const holder = ctx as { get?: (name: string) => unknown; shortcuts?: unknown }
  let service: unknown
  try {
    service = typeof holder.get === 'function' ? holder.get('shortcuts') : holder.shortcuts
  } catch {
    return undefined
  }
  if (!service || typeof service !== 'object') return undefined
  return service as ShortcutsServiceLike
}

function currentRevision(service: ShortcutsServiceLike | undefined): string | null {
  const snapshot = service?.config?.getSnapshot?.()
  return snapshot && typeof snapshot.revision === 'string' ? snapshot.revision : null
}

function currentCatalog(service: ShortcutsServiceLike | undefined): readonly ShortcutCatalogEntryLike[] {
  const catalog = service?.catalog?.getSnapshot?.()
  return Array.isArray(catalog) ? catalog : []
}

function detectPlatform(): string {
  const device = navigator.userAgent
  if (/mac/i.test(device)) return 'macos'
  if (/win/i.test(device)) return 'windows'
  return 'linux'
}

/**
 * 装配桌面档快捷键桥。只在壳注入了 `dshDesktop.keyboard` 的页面（本地 loopback 窗口）
 * 生效；纯浏览器、远程窗口（Rust 只注入 __DSH_TRANSPORT__）什么都不装。
 */
export function installDesktopPlatformBridge(ctx: ClientContext): void {
  const w = window as unknown as {
    dshDesktop?: { keyboard?: unknown }
    __dshShellKeyboardImpl?: DesktopKeyboardBridgeImpl
    __dshShellKeyboardInstalled?: boolean
  }
  if (!w.dshDesktop || !w.dshDesktop.keyboard) return
  if (w.__dshShellKeyboardInstalled) return
  w.__dshShellKeyboardInstalled = true

  let service = readService(ctx)

  // dsh 的 shortcuts 服务可能晚于本插件注册：补一次作用域注入把服务引用接上
  // （拿不到也不影响桥本身——只是匹配不到目录、按不下 revision，按键照常放行）。
  if (!service) {
    const inject = (ctx as { inject?: unknown }).inject
    if (typeof inject === 'function') {
      ;(inject as (deps: string[], callback: (scoped: ClientContext) => void) => void).call(ctx, ['shortcuts'], (scoped) => {
        service = readService(scoped)
      })
    }
  }

  const runtime = typeof service?.runtime === 'string' ? service.runtime : 'desktop'
  const platform = typeof service?.platform === 'string' ? service.platform : detectPlatform()
  const profile = `${runtime}:${platform}`

  const adapter = new KeybindingAdapter(profile)
  const emitter = new KeyboardEmitter(
    () => currentRevision(service),
    () => currentCatalog(service),
  )
  emitter.attach()

  w.__dshShellKeyboardImpl = {
    subscribeInput: (listener) => emitter.subscribe(listener),
    closeWindow: async (revision) => {
      if (currentRevision(service) !== revision) return
      await tauriInvoke<void>('close_current_window')
    },
    get: () => adapter.get(),
    edit: (edit, revision) => adapter.edit(edit, revision),
    subscribeConfig: (listener) => adapter.subscribe(listener),
    recording: async (active) => {
      emitter.setRecording(active)
    },
  }
  console.info(`[desktop] platform 键盘桥实现已就绪（profile=${profile}）`)
  // 一次性接线自检：3 秒后把桥的状态写进日志。用户报「快捷键没反应」时，这一行足以
  // 区分三种情况：桥没接上（service=null）、目录是空的（catalog=0）、dsh 没订阅（listeners=0）。
  setTimeout(() => {
    const catalog = currentCatalog(service)
    console.info(
      '[desktop] 快捷键桥自检：' +
        JSON.stringify({
          service: service ? `${service.runtime ?? '?'}:${service.platform ?? '?'}` : null,
          catalog: catalog.length,
          revision: currentRevision(service) !== null,
          listeners: emitter.listenerCount(),
        }),
    )
  }, 3000)
}
