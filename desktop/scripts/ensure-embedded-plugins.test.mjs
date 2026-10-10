#!/usr/bin/env node
/**
 * ensure-embedded-plugins.test.mjs —— 守卫的单元测试（#212），跑法：
 *   cd desktop && npm run test:scripts
 *
 * 覆盖：齐全 / 缺子模块 / 空目录 / 与 build.rs 的清单一致性（防止两份清单漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMBEDDED_PLUGINS, findMissingPlugins, formatIssues } from './ensure-embedded-plugins.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** 造一个「三个插件源齐全」的临时仓库根。 */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'embed-plugins-'))
  for (const plugin of EMBEDDED_PLUGINS) {
    const src = join(root, plugin.rel)
    mkdirSync(src, { recursive: true })
    for (const file of plugin.files) writeFileSync(join(src, file), '{}\n')
    for (const dir of plugin.dirs) {
      mkdirSync(join(src, dir), { recursive: true })
      writeFileSync(join(src, dir, 'entry.js'), '\n')
    }
  }
  return root
}

test('三个插件源齐全时没有问题', () => {
  const root = fixtureRoot()
  try {
    assert.deepEqual(findMissingPlugins(root), [])
    assert.equal(formatIssues([], root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('本仓库当前 checkout 就绪（子模块已检出时）', () => {
  assert.deepEqual(
    findMissingPlugins(repoRoot).map((issue) => issue.name),
    [],
  )
})

test('子模块为空目录 → 报 dsh-web-mobile 缺件，并给出子模块补救命令', () => {
  const root = fixtureRoot()
  try {
    rmSync(join(root, 'mobile/dsh-mobile-nav'), { recursive: true, force: true })
    const issues = findMissingPlugins(root)
    assert.deepEqual(
      issues.map((issue) => issue.name),
      ['dsh-web-mobile'],
    )
    const report = formatIssues(issues, root)
    assert.match(report, /git submodule update --init --recursive/)
    assert.match(report, /dsh-web-mobile/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('声明的子目录为空 → 视为缺件（空 lib/ 正是 0.12.0 的形态）', () => {
  const root = fixtureRoot()
  try {
    rmSync(join(root, 'mobile/dsh-mobile-nav/lib'), { recursive: true, force: true })
    mkdirSync(join(root, 'mobile/dsh-mobile-nav/lib'), { recursive: true })
    const issues = findMissingPlugins(root)
    assert.equal(issues.length, 1)
    assert.match(formatIssues(issues, root), /lib\/（空目录）/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('清单与 build.rs 的 packages 表逐项一致（两份清单一处改动另一处必须跟）', () => {
  const source = readFileSync(resolve(repoRoot, 'desktop/src-tauri/build.rs'), 'utf8')
  const table = source.match(/let packages:[^=]*=\s*\[([\s\S]*?)\n    \];/)
  assert.ok(table !== null, 'build.rs 里找不到 packages 表')
  const entry = /\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*&\[([^\]]*)\]\s*,\s*&\[([^\]]*)\]\s*,?\s*\)/g
  const names = (list) => list.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? []
  const fromRust = [...table[1].matchAll(entry)].map((m) => ({
    name: m[1],
    rel: m[2],
    files: names(m[3]),
    dirs: names(m[4]),
  }))
  assert.deepEqual(fromRust, EMBEDDED_PLUGINS)
})
