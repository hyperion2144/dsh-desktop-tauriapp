/**
 * composer 输入守护（#188）：拦下控制字符插入，不让乱码字符留在输入框里。
 *
 * 症状（用户实机）：输入框为空、或光标在末尾时按方向键（尤其右方向键），会插入一个不可见
 * 乱码字符；票内证据是该字符为 **U+001D（C0 控制字符）**（用户消息原文里被内容转义层写成
 * `\u001d`）。composer 是 Lexical 富文本（`dsh-client-ui-conversation`），dsh 自己没有任何
 * ArrowLeft/ArrowRight 级处理。
 *
 * 归属（隔离实例里临时追踪实测）：按方向键 → 编辑层自己发出一个
 * `beforeinput {inputType:"insertText", data:"\u001d"}`（右→U+001D、左→U+001C），
 * 与 dsh/Lexical 无关；输入法的 `insertFromComposition` 是正常文本，照常放行。
 *
 * 于是本模块用**三层网**，不论字符从哪条路径进来都不让它留在文档里：
 * 1. `beforeinput`（capture，最先跑）：数据里带控制字符就 `preventDefault()` 并
 *    `stopImmediatePropagation()`——既挡住浏览器默认插入，也让 Lexical 自己的 beforeinput
 *    处理器收不到事件；只对可编辑目标生效，不动页面其它输入面。
 * 2. `input` / `compositionend`（capture）：字符已经进 DOM 时，直接把控制字符从可编辑区
 *    文本里删掉（Lexical 的 MutationObserver 会把这次 DOM 变化并回它自己的模型）。
 * 3. 自己的 MutationObserver：输入法直接写 DOM、连 `input` 事件都不发时兜底，同样删掉。
 *
 * 制表/换行/回车一律放行（多行 composer 的正常输入）。纯函数在 scripts/test-client.mjs 里锁死。
 */

/** 允许出现在 composer 文本里的控制字符：制表、换行、回车。 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d])

function isDisallowed(code: number): boolean {
  if (code > 0x1f && code !== 0x7f) return false
  return !ALLOWED_CONTROL.has(code)
}

/** 文本里是否含不该出现的控制字符（C0 与 DEL）。 */
export function hasDisallowedControl(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text === '') return false
  for (const char of text) {
    if (isDisallowed(char.codePointAt(0) ?? 0)) return true
  }
  return false
}

/** 删掉文本里所有不该出现的控制字符（其余原样保留，含增补平面字符）。 */
export function removeDisallowedControl(text: string | null | undefined): string {
  if (typeof text !== 'string' || text === '') return ''
  let out = ''
  for (const char of text) {
    if (isDisallowed(char.codePointAt(0) ?? 0)) continue
    out += char
  }
  return out
}

/** 把文本里的控制字符渲染成 `U+001D@3` 这样的证据串（不含原文，避免隐私进日志）。 */
export function describeControlChars(text: string | null | undefined): string {
  if (typeof text !== 'string' || text === '') return ''
  const parts: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (!isDisallowed(code)) continue
    parts.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}@${index}`)
  }
  return parts.join(',')
}

interface GuardWindow {
  __dshComposerInputGuardInstalled?: boolean
}

/** 目标描述：标签 + 是否 contenteditable + 是否 composer（Lexical 根会带 data-composer-composing）。 */
function describeTarget(node: EventTarget | null): string {
  const el = (isElement(node) ? node : document.activeElement) as HTMLElement | null
  if (el === null) return 'none'
  const tag = (el.tagName ?? '').toLowerCase()
  const editable = el.isContentEditable ? '+contenteditable' : ''
  const composer = typeof el.closest === 'function' && el.closest('[data-composer-composing]') !== null ? '+composer' : ''
  return `${tag}${editable}${composer}`
}

function isElement(node: unknown): node is HTMLElement {
  return node instanceof HTMLElement
}

function isFieldElement(el: HTMLElement): boolean {
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
}

/** 可编辑根：contenteditable 元素、输入框本身，或文本节点的最近可编辑祖先。 */
function editableRootOf(node: EventTarget | null): HTMLElement | null {
  if (isElement(node)) return node.isContentEditable || isFieldElement(node) ? node : null
  if (node !== null && (node as Node).nodeType === 3) {
    const parent = (node as Node).parentElement
    if (parent === null) return null
    return parent.isContentEditable || isFieldElement(parent) ? parent : null
  }
  const active = document.activeElement as HTMLElement | null
  if (active === null) return null
  return active.isContentEditable || isFieldElement(active) ? active : null
}

function trace(kind: string, payload: Record<string, unknown>): void {
  try {
    console.info(`[input-guard] ${kind} ${JSON.stringify(payload)}`)
  } catch {
    /* 日志失败不影响页面 */
  }
}

function stackOf(): string {
  try {
    return (new Error().stack ?? '').split('\n').slice(1, 5).join(' | ')
  } catch {
    return ''
  }
}

/** 深度优先收集子树里的文本节点（不用 TreeWalker，便于在 vm 桩里跑）。 */
function textNodesOf(root: Node): Text[] {
  const out: Text[] = []
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Node
    if (node.nodeType === 3) {
      out.push(node as Text)
      continue
    }
    const children = node.childNodes
    if (children === undefined || children === null) continue
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index] as Node)
  }
  return out
}

/**
 * 把可编辑子树里文本节点上的控制字符删掉。
 * 返回删掉的控制字符证据串（空串表示没删）。
 */
function sanitizeEditable(root: HTMLElement | null): string {
  if (root === null) return ''
  let removed = ''
  for (const node of textNodesOf(root as unknown as Node)) {
    if (!hasDisallowedControl(node.data)) continue
    removed += describeControlChars(node.data)
    node.data = removeDisallowedControl(node.data)
  }
  if (removed !== '') return removed
  // 输入框（非 contenteditable）走 value
  const tag = (root.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    const field = root as unknown as HTMLTextAreaElement
    const value = typeof field.value === 'string' ? field.value : ''
    if (hasDisallowedControl(value)) {
      removed = describeControlChars(value)
      field.value = removeDisallowedControl(value)
    }
  }
  return removed
}

/**
 * 安装 composer 输入守护（幂等）。只在壳 client 插件装载时调一次。
 */
export function installComposerInputGuard(): void {
  const w = globalThis as unknown as GuardWindow
  if (w.__dshComposerInputGuardInstalled) return
  w.__dshComposerInputGuardInstalled = true
  // 方向键每按一次都会触发一次拦截，日志留个上限，免得刷爆 webview 日志。
  const MAX_BLOCKED_LOGS = 3
  let blockedLogs = 0

  // ── 第 1 层：控制字符插入拦截（只对可编辑目标，挡在浏览器默认插入之前）──
  const onBeforeInput = (event: Event): void => {
    const input = event as InputEvent
    if (editableRootOf(event.target) === null) return
    const data = typeof input.data === 'string' ? input.data : null
    let transfer: string | null = null
    try {
      transfer = input.dataTransfer?.getData('text/plain') ?? null
    } catch {
      transfer = null
    }
    const offending = hasDisallowedControl(data) ? data : hasDisallowedControl(transfer) ? transfer : null
    if (offending === null) return
    if (blockedLogs < MAX_BLOCKED_LOGS) {
      blockedLogs += 1
      trace('blocked', {
        inputType: input.inputType,
        control: describeControlChars(offending),
        target: describeTarget(event.target),
        stack: stackOf(),
      })
    }
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
  document.addEventListener('beforeinput', onBeforeInput, true)

  // ── 第 2 层：已经进 DOM 的，擦掉 ──────────────────────────────────────
  const onLateInput = (event: Event): void => {
    const root = editableRootOf(event.target)
    const removed = sanitizeEditable(root)
    if (removed === '') return
    trace('sanitized', {
      via: event.type,
      control: removed,
      target: describeTarget(event.target),
      stack: stackOf(),
    })
  }
  document.addEventListener('input', onLateInput, true)
  document.addEventListener('compositionend', onLateInput, true)

  // ── 第 3 层：输入法直接写 DOM（不发 input）时的兜底 ────────────────────
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Node
      const root = editableRootOf(target)
      if (root === null) continue
      const removed = sanitizeEditable(root)
      if (removed === '') continue
      trace('sanitized', {
        via: `mutation:${record.type}`,
        control: removed,
        target: describeTarget(root),
      })
    }
  })
  observer.observe(document.documentElement ?? document, {
    subtree: true,
    childList: true,
    characterData: true,
  })

}
