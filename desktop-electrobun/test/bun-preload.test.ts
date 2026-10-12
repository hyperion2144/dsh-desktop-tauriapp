// Bun 兼容层（bun-preload.mjs）的补丁应用测试（不含真 dsh 运行时，缝 ② 可测）。
//
// 做法：造一棵假 node_modules，把上游文件的关键文本写进去，然后用真 bun 跑
// `bun --preload <preload> <script>`（`DSH_BUN_PRELOAD_TREES=<假树>` 指路），
// 进程跑完后断言文件被改写成了什么。
//
// 注意两条：
//   · 子进程的 cwd / argv[1] 都在临时目录里 —— 兼容层会顺着这两条往上找 node_modules，
//     否则它可能摸到仓库自己的树；
//   · 补丁是**持久**的（`_patches` 只记账，不还原），所以退出后可以直接读文件。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const projectRoot = resolve(import.meta.dir, '..')
const preloadPath = resolve(projectRoot, '..', 'desktop', 'src-tauri', 'resources', 'dsh', 'bun-preload.mjs')

const roots: string[] = []

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preload-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 上游 inspector 里那三行的真实形态（真正被替换的是第三行）。 */
const INSPECTOR_UPSTREAM = [
  'const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");',
  'const original = globalThis.fetch;',
  'if (typeof original !== "function") throw new Error("inspector: globalThis.fetch is unavailable");',
  '\tif (descriptor !== void 0 && !("value" in descriptor)) throw new Error("inspector: globalThis.fetch is an accessor and cannot be observed safely");',
  'export const done = true;',
  '',
].join('\n')

function inspectorPath(tree: string): string {
  return join(tree, 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector', 'lib', 'index.js')
}

function writeInspector(tree: string, content: string): string {
  const file = inspectorPath(tree)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

/** 跑一次兼容层（真 bun 子进程），返回 stdout/stderr。 */
function runPreload(tree: string): { stdout: string; stderr: string; code: number } {
  const script = join(tree, 'noop.mjs')
  writeFileSync(script, 'console.log("child-ok")\n', 'utf8')
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-install', '--preload', preloadPath, script],
    cwd: tree,
    env: { ...process.env, DSH_BUN_PRELOAD_TREES: tree },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { stdout: child.stdout.toString(), stderr: child.stderr.toString(), code: child.exitCode ?? -1 }
}

describe('bun-preload Patch 12（inspector 的 fetch 访问器）', () => {
  test('把「访问器就拒绝启动」改成先归一成数据属性', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM)

    const result = runPreload(tree)
    const patched = readFileSync(inspectorPath(tree), 'utf8')

    // console.log 走 stdout，console.warn 才走 stderr。
    expect(result.stdout).toContain('Patch 12: fetch 访问器归一 applied')
    expect(patched).toContain('bun-preload: fetch 访问器归一')
    expect(patched).not.toContain('cannot be observed safely')
    // 归一那句必须是「把当时的 fetch 落成数据属性」——只删检查不归一，后面照样读不到值。
    expect(patched).toContain('Object.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true })')
    // 同文件其余行不能动。
    expect(patched).toContain('const original = globalThis.fetch;')
    expect(patched).toContain('export const done = true;')
  })

  test('重复启动幂等（不叠第二份归一）', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM)

    runPreload(tree)
    const first = readFileSync(inspectorPath(tree), 'utf8')
    const second = runPreload(tree)

    expect(second.stdout).toContain('Patch 12: bun-preload-rev:')
    expect(readFileSync(inspectorPath(tree), 'utf8')).toBe(first)
    expect(first.split('bun-preload: fetch 访问器归一').length - 1).toBe(1)
  })

  test('上游文本变了只警告、不动文件（下次上游自带修复也不会被我们覆盖）', () => {
    const tree = tempTree()
    const drifted = INSPECTOR_UPSTREAM.replace('cannot be observed safely', 'cannot be observed at all')
    writeInspector(tree, drifted)

    const result = runPreload(tree)

    expect(result.stderr).toContain('Patch 12: 未找到上游 accessor 检查文本')
    expect(readFileSync(inspectorPath(tree), 'utf8')).toBe(drifted)
  })

  test('没装 inspector 时不报错（包不存在就整段跳过）', () => {
    const tree = tempTree()
    const result = runPreload(tree)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('child-ok')
    expect(result.stderr).not.toContain('Patch 12: 未找到上游 accessor 检查文本')
  })
})
