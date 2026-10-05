/**
 * client 纯函数测试入口（node scripts/test-client.mjs）。
 * 用 esbuild 把 TS 纯函数模块转译到临时目录后动态 import 断言，
 * 不给 client 引入测试框架依赖。目前覆盖 download-intercept 的拦截判定、
 * platform-keyboard（#187）的绑定匹配 / keybindings 解析与编辑。
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = join(root, '.test-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

await build({
  entryPoints: [join(root, 'src/client/download-intercept.ts')],
  outfile: join(tmp, 'download-intercept.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { shouldIntercept, filenameFromAnchor } = await import(join(tmp, 'download-intercept.mjs'))

// ── shouldIntercept：仅 blob:/data: 协议的 a[download] 才接管 ──
assert.equal(shouldIntercept('blob:http://127.0.0.1:3080/uuid', true), true, 'blob 链接应拦截')
assert.equal(shouldIntercept('data:text/plain;base64,SGk=', true), true, 'data 链接应拦截')
assert.equal(shouldIntercept('BLOB:https://h/x', true), true, '协议前缀大小写不敏感')
assert.equal(shouldIntercept('http://127.0.0.1:3080/api/session.export?sessionId=s1', true), false, 'http 直链走 on_download 转交，不拦')
assert.equal(shouldIntercept('https://example.com/f.zip', true), false, 'https 直链不拦')
assert.equal(shouldIntercept('blob:http://h/x', false), false, '无 download 属性不拦（普通导航）')
assert.equal(shouldIntercept(null, true), false, '无 href 不拦')
assert.equal(shouldIntercept(null, false), false, '都缺不拦')

// ── filenameFromAnchor：download 属性优先，回退 URL 尾段 ──
assert.equal(filenameFromAnchor('report.zip', 'blob:http://h/uuid'), 'report.zip', 'download 属性优先')
assert.equal(filenameFromAnchor('  ', 'blob:http://h/uuid'), 'uuid', '空白属性回退 blob 尾段')
assert.equal(filenameFromAnchor(null, 'data:text/plain;base64,xx'), 'download', 'data URL 无路径段回退默认名')
assert.equal(filenameFromAnchor(null, 'blob:http://h/path/file.tar.gz'), 'file.tar.gz', 'URL 尾段含扩展名')
assert.equal(filenameFromAnchor('报告 v1.2.pdf', 'blob:x'), '报告 v1.2.pdf', '中文文件名保留')

// ── platform-keyboard（#187）：桌面档快捷键桥的纯函数 ──
await build({
  entryPoints: [join(root, 'src/client/platform-keyboard.ts')],
  outfile: join(tmp, 'platform-keyboard.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const kb = await import(join(tmp, 'platform-keyboard.mjs'))
const gesture = (over = {}) => ({
  code: 'Period',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  repeat: false,
  ...over,
})
const bound = (binding, over = {}) => ({ id: 'x', binding, issue: null, conflicts: [], ...over })

// ── 修饰键判定 ──
assert.equal(kb.isModifierCode('MetaLeft'), true, 'MetaLeft 是修饰键')
assert.equal(kb.isModifierCode('ShiftRight'), true, 'ShiftRight 是修饰键')
assert.equal(kb.isModifierCode('KeyK'), false, '字母键不是修饰键')
assert.equal(kb.isModifierCode('Period'), false, 'Period 不是修饰键')
assert.deepEqual(
  kb.gestureModifiers(gesture({ shift: true, meta: true })),
  ['shift', 'meta'],
  '修饰键按 control/alt/shift/meta 排序',
)
assert.deepEqual(kb.gestureModifiers(gesture()), [], '无修饰键回空数组')

// ── 命中判定（与 dsh 的 bindingKey 等价：修饰键集合 + 键位集合）──
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ shift: true, meta: true })),
  true,
  '修饰键与主键都吻合则命中',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ meta: true })),
  false,
  '少一个修饰键不命中',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ shift: true, meta: true, alt: true })),
  false,
  '多一个修饰键不命中（不做子集匹配）',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta', 'shift'] }), gesture({ code: 'Comma', shift: true, meta: true })),
  false,
  '主键不同不命中',
)
assert.equal(
  kb.matchBinding(bound(null), gesture({ shift: true, meta: true })),
  false,
  '无绑定不命中',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta'] }, { issue: 'reserved' }), gesture({ meta: true })),
  false,
  '带 issue 的绑定不命中（dsh 也会把它标成不可用）',
)
assert.equal(
  kb.matchBinding(bound({ code: 'Period', modifiers: ['meta'] }, { conflicts: ['other'] }), gesture({ meta: true })),
  false,
  '有冲突的绑定不命中',
)
assert.equal(
  kb.matchBinding(
    bound({ code: 'KeyK', secondCode: 'KeyS', modifiers: ['meta'] }),
    gesture({ code: 'KeyS', secondCode: 'KeyK', meta: true }),
  ),
  true,
  '双键组合与录入顺序无关',
)

// ── 可吞判定：裸键绝不吞（否则吃掉正常输入）──
assert.equal(kb.isConsumable(bound({ code: 'Period', modifiers: ['meta'] })), true, '带修饰键可吞')
assert.equal(kb.isConsumable(bound({ code: 'Period', modifiers: [] })), false, '裸键不可吞')
assert.equal(kb.isConsumable(bound(null)), false, '无绑定不可吞')

// ── catalog 匹配：取第一行「命中且可吞」──
const catalog = [
  bound({ code: 'Period', modifiers: ['meta'] }),
  { id: 'bare', binding: { code: 'Period', modifiers: [] }, issue: null, conflicts: [] },
  { id: 'second', binding: { code: 'KeyK', modifiers: ['meta'] }, issue: null, conflicts: [] },
]
assert.equal(kb.matchCatalog(catalog, gesture({ meta: true }))?.id, 'x', '命中第一行可吞的绑定')
assert.equal(kb.matchCatalog(catalog, gesture({ code: 'KeyK', meta: true }))?.id, 'second', '跳过不可吞的裸键行')
assert.equal(kb.matchCatalog(catalog, gesture({ code: 'KeyJ', meta: true })), undefined, '无命中回 undefined')

// ── keybindings 解析（契约对齐 dsh 的 parseShortcutDocument）──
assert.equal(kb.SHORTCUT_SCHEMA_VERSION, 2, '当前支持到 schemaVersion 2')
const empty = kb.parseShortcutDocument(null)
assert.equal(empty.status, 'ready', '文件不存在视为 ready')
assert.equal(empty.usingDefaults, true, '文件不存在时用默认绑定')
assert.deepEqual(empty.document, { schemaVersion: 1, profiles: {} }, '空文档形状')
assert.equal(kb.parseShortcutDocument('   ').usingDefaults, true, '空白内容视为未配置')
assert.equal(kb.parseShortcutDocument('not json').error, 'invalid', '坏 JSON 标 invalid')
assert.equal(kb.parseShortcutDocument('not json').status, 'unreadable', '坏 JSON 只读不覆盖')
assert.equal(kb.parseShortcutDocument('[1]').error, 'invalid', '数组不是合法文档')
assert.equal(kb.parseShortcutDocument('{"schemaVersion":0}').error, 'invalid', '版本号必须为正整数')
assert.equal(kb.parseShortcutDocument('{"schemaVersion":3,"profiles":{}}').error, 'future', '未来版本只读（老壳不写坏新文件）')
const parsed = kb.parseShortcutDocument(
  '{"schemaVersion":1,"profiles":{"web:macos":{"a.b":{"code":"KeyK","modifiers":["meta"]}}},"unknown":7}',
)
assert.equal(parsed.status, 'ready', '合法文档 ready')
assert.equal(parsed.usingDefaults, false, '有文件就不算默认')
assert.equal(parsed.document.unknown, 7, '未知顶层字段原样保留')
assert.equal(parsed.document.profiles['web:macos']['a.b'].code, 'KeyK', 'profile 表原样保留')

// ── 编辑应用 ──
const edited = kb.applyShortcutEdit(empty.document, { type: 'set', id: 'inspector.toggle', binding: { code: 'Period', modifiers: ['primary', 'shift', 'meta'] } }, 'desktop:macos')
assert.equal(edited.ok, true, 'set 成功')
assert.equal(edited.document.schemaVersion, 2, '编辑即升到 v2')
assert.deepEqual(
  edited.document.profiles['desktop:macos']['inspector.toggle'],
  { code: 'Period', modifiers: ['shift', 'meta'] },
  '只保留 dsh 认的修饰键（primary 展开后由页面侧给出 meta）',
)
assert.deepEqual(empty.document.profiles, {}, '编辑不改原对象（不可变）')
const reset = kb.applyShortcutEdit(edited.document, { type: 'reset', id: 'inspector.toggle' }, 'desktop:macos')
assert.equal(reset.ok, true, 'reset 成功')
assert.deepEqual(reset.document.profiles['desktop:macos'], {}, 'reset 删掉该条覆盖')
const resetAll = kb.applyShortcutEdit(edited.document, { type: 'reset-all' }, 'desktop:macos')
assert.deepEqual(resetAll.document.profiles['desktop:macos'], {}, 'reset-all 清空该 profile')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'set', id: '', binding: { code: 'KeyK', modifiers: ['meta'] } }, 'desktop:macos').ok, false, '空 id 拒绝')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'set', id: 'a', binding: { code: '', modifiers: [] } }, 'desktop:macos').ok, false, '空 code 拒绝')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'set', id: 'a', binding: null }, 'desktop:macos').ok, false, '非对象绑定拒绝')
assert.equal(kb.applyShortcutEdit(edited.document, { type: 'nope' }, 'desktop:macos').ok, false, '未知编辑类型拒绝')

// ── Rust 注入的 dshDesktop 载体脚本（#187）：在最小 DOM 桩里真跑一遍 ──
// 这段 JS 只在真机窗口里执行，语法错/占位符漏替只在运行时暴露；这里从 Rust 源取出
// 原文、替掉两个占位符、放进 node:vm 的最小 DOM 桩里跑，锁住它的对外形状。
const carrierSource = readFileSync(join(root, 'desktop/src-tauri/src/ui/browser_guests/mod.rs'), 'utf8')
const carrierRaw = carrierSource.match(/const DESKTOP_CARRIER_INIT_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1]
assert.ok(carrierRaw, '能从 Rust 源里取出载体脚本原文')
assert.ok(carrierRaw.includes('__DSH_PLATFORM_NAME__'), '载体里保留平台名占位符')
assert.ok(carrierRaw.includes('__DSH_SHELL_ORIGIN_TEST__'), '载体里保留 origin 判定占位符')

function runCarrier({ origin, impl, timers = 'never' }) {
  const script = carrierRaw
    .replace('__DSH_SHELL_ORIGIN_TEST__', "function (o) { return o === 'dshapp://localhost' }")
    .replace('__DSH_PLATFORM_NAME__', 'macos')
  const sandbox = {
    location: { origin },
    document: { documentElement: { dataset: {} } },
    // 默认给一个「永不触发」的 setTimeout：桩里的轮询是一直等到实现出现为止的，
    // 测试不需要它真的推进（用真实定时器会让 node 空转 30s 才退出）。
    setTimeout: timers === 'live' ? setTimeout : () => 0,
    clearTimeout,
    console,
    __dshShellKeyboardImpl: impl?.keyboard,
    __dshShellBridgeImpl: impl?.browser,
  }
  createContext(sandbox)
  runInContext(script, sandbox, { filename: 'desktop-carrier.js' })
  return sandbox
}

const carrier = runCarrier({ origin: 'dshapp://localhost' })
assert.equal(carrier.dshDesktop?.protocolVersion, 1, '壳内 origin 上安装 dshDesktop')
assert.equal(carrier.document.documentElement.dataset.platform, 'macos', '写入平台名标记（不是 darwin，不触碰 dsh 的 Electron 几何）')
for (const method of ['subscribe', 'closeWindow']) {
  assert.equal(typeof carrier.dshDesktop.keyboard[method], 'function', `暴露 DesktopKeyboardApi.${method}`)
}
for (const method of ['get', 'edit', 'subscribe', 'recording']) {
  assert.equal(typeof carrier.dshDesktop.shortcuts[method], 'function', `暴露 DesktopShortcutsApi.${method}`)
}
assert.equal(typeof carrier.dshDesktop.browser.acquire, 'function', '原有 browser.acquire 未被破坏')

// 实现未就绪（client 插件还没装）：一切同步可调、不炸，get 仍返回 Promise
const earlyDisposer = carrier.dshDesktop.keyboard.subscribe(() => {})
assert.equal(typeof earlyDisposer, 'function', '实现未就绪时 subscribe 也同步返回 disposer')
assert.equal(typeof carrier.dshDesktop.shortcuts.get([]).then, 'function', '实现未就绪时 get 也返回 Promise（dsh 构造期直接取用）')
assert.equal(typeof carrier.dshDesktop.shortcuts.recording(true).then, 'function', 'recording 也返回 Promise')
earlyDisposer()

// 实现就绪（client 插件已装）：订阅挂到实现上、调用逐项转发
const seen = []
const ready = runCarrier({
  origin: 'dshapp://localhost',
  impl: {
    keyboard: {
      subscribeInput: (listener) => {
        seen.push(listener)
        return () => seen.push('off')
      },
      closeWindow: async (revision) => {
        seen.push(`close:${revision}`)
      },
      get: async (definitions) => `snapshot:${definitions.length}`,
      edit: async (edit, revision) => `edit:${edit.type}:${revision}`,
      subscribeConfig: () => () => {},
      recording: async () => {},
    },
    browser: { acquire: async (workspace) => `lease:${workspace}` },
  },
})
const forwardDisposer = ready.dshDesktop.keyboard.subscribe((input) => seen.push(`input:${input.code}`))
assert.equal(await ready.dshDesktop.browser.acquire('ws-1'), 'lease:ws-1', 'browser.acquire 仍惰性转发')
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(typeof seen[0], 'function', 'subscribe 经微任务后挂到 subscribeInput 上')
seen[0]({ kind: 'keyboard', code: 'Period' })
assert.ok(seen.includes('input:Period'), '实现推来的原生输入原样送进监听器')
assert.equal(await ready.dshDesktop.shortcuts.get([1, 2, 3]), 'snapshot:3', 'shortcuts.get 转发到实现')
assert.equal(await ready.dshDesktop.shortcuts.edit({ type: 'reset-all' }, 'rev-1'), 'edit:reset-all:rev-1', 'shortcuts.edit 转发到实现')
await ready.dshDesktop.keyboard.closeWindow('rev-1')
assert.ok(seen.includes('close:rev-1'), 'closeWindow 转发到实现')
forwardDisposer()
assert.ok(seen.includes('off'), 'disposer 透传到实现的退订')

// 实现晚到（真实定时器）：轮询等到实现出现后把订阅补上
const late = runCarrier({ origin: 'dshapp://localhost', timers: 'live' })
const lateSeen = []
late.dshDesktop.keyboard.subscribe((input) => lateSeen.push(input.code))
await new Promise((resolve) => setTimeout(resolve, 250))
late.__dshShellKeyboardImpl = {
  subscribeInput: (listener) => {
    lateSeen.push('attached')
    late.__push = listener
    return () => {}
  },
}
await new Promise((resolve) => setTimeout(resolve, 250))
assert.ok(lateSeen.includes('attached'), '实现晚到时订阅自动补上（惰性轮询）')
late.__push({ code: 'KeyK' })
assert.ok(lateSeen.includes('KeyK'), '晚到的实现同样能把输入送进监听器')

// 非壳内页面：完全不安装载体（回落 web 档）
assert.equal(runCarrier({ origin: 'https://example.com' }).dshDesktop, undefined, '非壳内 origin 不装载体')

// ── composer-input-guard（#188）：控制字符判定与取证串 ──
await build({
  entryPoints: [join(root, 'src/client/composer-input-guard.ts')],
  outfile: join(tmp, 'composer-input-guard.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const guard = await import(join(tmp, 'composer-input-guard.mjs'))

assert.equal(guard.hasDisallowedControl(null), false, 'null 放行')
assert.equal(guard.hasDisallowedControl(''), false, '空串放行')
assert.equal(guard.hasDisallowedControl('普通文本 abc'), false, '常规文本放行')
assert.equal(guard.hasDisallowedControl('多行\n文本\t带制表\r'), false, '换行/制表/回车放行（多行 composer 正常输入）')
assert.equal(guard.hasDisallowedControl('🙂 emoji'), false, '增补平面字符（代理对）不误判')
assert.equal(guard.hasDisallowedControl('\u001d'), true, 'U+001D（本票的乱码字符）要拦')
assert.equal(guard.hasDisallowedControl('前面有字\u0000后面'), true, 'U+0000 要拦')
assert.equal(guard.hasDisallowedControl('a\u001bb'), true, 'U+001B（ESC）要拦')
assert.equal(guard.hasDisallowedControl('\u007f'), true, 'U+007F（DEL）要拦')
assert.equal(guard.describeControlChars('abc\u001d'), 'U+001D@3', '取证串带码点与下标')
assert.equal(guard.describeControlChars('a\u0000b\u007f'), 'U+0000@1,U+007F@3', '多个控制字符逐个列出')
assert.equal(guard.describeControlChars('普通文本'), '', '无控制字符时取证串为空')
assert.equal(guard.removeDisallowedControl('a\u001db\u0000'), 'ab', '删掉控制字符、保留其余')
assert.equal(guard.removeDisallowedControl('多行\n文本\t'), '多行\n文本\t', '换行/制表保留')
assert.equal(guard.removeDisallowedControl('🙂a'), '🙂a', '增补平面字符不被破坏')

// ── composer-input-guard 的三层网：最小 DOM 桩里真跑一遍（#188）──
// 桩里造事件与元素（跨 realm 的 instanceof 必须成立）；fire 按 DOM 语义在
// stopImmediatePropagation 处停下，用来证明拦截确实掉断了后续（Lexical）处理器。
const guardStub = `
const listeners = [];
const doc = {
  activeElement: null,
  documentElement: { marks: {}, hasAttribute(n) { return Boolean(this.marks[n]) } },
  addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: Boolean(capture) }) },
};
const document = doc;
class TestElement {
  constructor(tag) { this.tagName = tag; this.isContentEditable = false; this.childNodes = []; this.nodeType = 1; this.marks = {}; }
  closest(sel) { return this.marks[sel] ? this : null }
  appendChild(node) { this.childNodes.push(node); node.parentElement = this; node.parentNode = this; return node }
}
const HTMLElement = TestElement;
let observerCallback = null;
class MutationObserver { constructor(cb) { observerCallback = cb } observe() {} }
const makeText = (data, parent) => { const node = { nodeType: 3, data, parentElement: parent, parentNode: parent }; if (parent) parent.childNodes.push(node); return node };
const fire = (type, event) => { for (const l of listeners) { if (l.type !== type) continue; l.fn(event); if (event.__immediateStopped) break } };
globalThis.__guardTest = { install: installComposerInputGuard, doc, TestElement, makeText, fire, observed: () => observerCallback, listeners: () => listeners.length };
`
const guardSource = readFileSync(join(tmp, 'composer-input-guard.mjs'), 'utf8')
  .replace(/^export \{[^}]*\};?$/m, '')
assert.ok(!guardSource.includes('export '), '转译产物里的 export 已剥掉（vm 里当脚本跑）')
const guardLogs = []
const guardSandbox = {
  console: { info: (...args) => guardLogs.push(args.join(' ')) },
  setTimeout,
  clearTimeout,
}
createContext(guardSandbox)
runInContext(guardStub + guardSource, guardSandbox, { filename: 'composer-input-guard.js' })
const gt = guardSandbox.__guardTest
gt.install()
const guardListeners = gt.listeners()
gt.install()
assert.equal(gt.listeners(), guardListeners, '重复安装幂等')

const composer = new gt.TestElement('DIV')
composer.isContentEditable = true
composer.marks['[data-composer-composing]'] = true
const mkEvent = (extra = {}) => ({
  target: composer,
  type: 'beforeinput',
  data: null,
  inputType: 'insertText',
  isComposing: false,
  defaultPrevented: false,
  __immediateStopped: false,
  stopped: false,
  preventDefault() { this.defaultPrevented = true },
  stopPropagation() { this.stopped = true },
  stopImmediatePropagation() { this.stopped = true; this.__immediateStopped = true },
  ...extra,
})

// 第 1 层：控制字符被拦，且事件不再往后传（Lexical 的 beforeinput 收不到）
let lexicalRuns = 0
gt.doc.addEventListener('beforeinput', () => { lexicalRuns += 1 }, true)
const blocked = mkEvent({ data: '\u001d' })
gt.fire('beforeinput', blocked)
assert.equal(blocked.defaultPrevented, true, 'U+001D 的 beforeinput 被 preventDefault')
assert.equal(blocked.__immediateStopped, true, '掉断传播：后续处理器不会收到这个事件')
assert.equal(lexicalRuns, 0, '后续（Lexical 式）处理器确实没跑')
assert.ok(guardLogs.some((l) => l.includes('blocked') && l.includes('U+001D')), '拦下时留证据（码点 + 调用栈）')

// 正常输入不能受限
const passing = mkEvent({ data: '你好' })
gt.fire('beforeinput', passing)
assert.equal(passing.defaultPrevented, false, '正常文本不拦')
assert.equal(lexicalRuns, 1, '正常输入照常传给后续处理器')

// 第 2 层：已经进 DOM 的，从文本节点里擦掉
const stuck = gt.makeText('前\u001d后', composer)
gt.fire('input', mkEvent({ type: 'input' }))
assert.equal(stuck.data, '前后', '已进 DOM 的控制字符被擦掉')
assert.ok(guardLogs.some((l) => l.includes('sanitized') && l.includes('via":"input')), '擦除也留证据')

// 第 3 层：输入法直接写 DOM（不发 input）时的 MutationObserver 兜底
const viaMutation = gt.makeText('a\u0007b', composer)
gt.observed()([{ type: 'characterData', target: viaMutation }])
assert.equal(viaMutation.data, 'ab', 'MutationObserver 兜底同样擦掉')

// 普通 input/textarea 走 value 分支
const area = new gt.TestElement('TEXTAREA')
area.value = 'x\u001dy'
gt.fire('input', mkEvent({ target: area, type: 'input' }))
assert.equal(area.value, 'xy', '输入框 value 里的控制字符也被擦掉')


rmSync(tmp, { recursive: true, force: true })
console.log('client 纯函数测试：全部通过 ✓')
