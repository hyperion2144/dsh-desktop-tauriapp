// 日志文件策略与写入（缝 ② 纯逻辑 + 真文件）。
//
// 守的是什么：旧壳的日志有两个好用的点（本地时区、单文件 10 MB）和一个坑
// （`KeepAll` 实测堆了 90+ 份 ≈900 MB）。这里把「本地时区」与「单文件大小」照抄，
// 把「不封顶」换成「固定份数」——份数、轮转顺序、删最旧，都是行为契约。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyLevel,
  formatLogLine,
  formatStamp,
  LOG_KEEP,
  LOG_MAX_BYTES,
  mirrorToShellLog,
  pageLogLines,
  pageLogPrefix,
  rotatePlan,
  rotatedName,
  shouldRotate,
} from '../src/shared/log-file.ts'
import { createLogSink, describeLogFile } from '../src/bun/log-sink.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-log-'))
}

describe('日志策略（纯逻辑）', () => {
  test('级别映射照旧壳：未知落 log', () => {
    expect(classifyLevel('error')).toBe('error')
    expect(classifyLevel('warn')).toBe('warn')
    expect(classifyLevel('info')).toBe('info')
    expect(classifyLevel('debug')).toBe('debug')
    expect(classifyLevel('log')).toBe('log')
    expect(classifyLevel('trace')).toBe('log')
    expect(classifyLevel('')).toBe('log')
  })

  test('前缀逐字对齐旧壳（含尾随空格）', () => {
    expect(pageLogPrefix('error')).toBe('[error]')
    expect(pageLogPrefix('warn')).toBe('[warn] ')
    expect(pageLogPrefix('info')).toBe('[info] ')
    expect(pageLogPrefix('debug')).toBe('[debug]')
    expect(pageLogPrefix('log')).toBe('[log]  ')
  })

  test('只有 warn/error 镜像进壳日志', () => {
    expect(mirrorToShellLog('warn')).toBe(true)
    expect(mirrorToShellLog('error')).toBe(true)
    expect(mirrorToShellLog('info')).toBe(false)
    expect(mirrorToShellLog('log')).toBe(false)
    expect(mirrorToShellLog('debug')).toBe(false)
  })

  test('时间戳是本地时区且定宽', () => {
    const stamp = formatStamp(new Date(2026, 9, 11, 23, 45, 1, 7))
    expect(stamp).toBe('2026-10-11 23:45:01.007')
    expect(formatLogLine('[shell] hi', new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04:05.006 [shell] hi')
  })

  test('页面日志多行逐行加前缀，缺 URL 写 ?', () => {
    expect(pageLogLines({ level: 'error', msg: 'boom\n第二行', pageUrl: 'http://x/y' })).toEqual([
      '[error] [page=http://x/y] boom',
      '[error]            第二行',
    ])
    expect(pageLogLines({ level: 'log', msg: 'hi', pageUrl: null })).toEqual(['[log]   [page=?] hi'])
  })

  test('消息以换行结尾时保留一个空行（旧壳语义）', () => {
    expect(pageLogLines({ level: 'info', msg: 'a\n', pageUrl: 'p' })).toEqual(['[info]  [page=p] a'])
  })

  test('轮转线：非空文件且写入后超限才轮转', () => {
    expect(shouldRotate(0, 10, 100)).toBe(false)
    expect(shouldRotate(95, 10, 100)).toBe(true)
    expect(shouldRotate(90, 10, 100)).toBe(false)
    expect(shouldRotate(LOG_MAX_BYTES - 1, 2, LOG_MAX_BYTES)).toBe(true)
  })

  test('轮转计划：逐级后移、超出份数的删掉', () => {
    const plan = rotatePlan('shell.log', ['shell.log', 'shell.log.1', 'shell.log.2', 'shell.log.3', 'shell.log.4'], 5)
    expect(plan.moves).toEqual([
      { from: 'shell.log.3', to: 'shell.log.4' },
      { from: 'shell.log.2', to: 'shell.log.3' },
      { from: 'shell.log.1', to: 'shell.log.2' },
      { from: 'shell.log', to: 'shell.log.1' },
    ])
    // keep=5 ⇒ 只留当前 + .1..4，位次 4 的旧内容直接丢
    expect(plan.deletes).toEqual(['shell.log.4'])
  })

  test('轮转计划：keep=3 时第 3 份以上被删；无关文件名不动', () => {
    const plan = rotatePlan('shell.log', ['shell.log', 'shell.log.1', 'shell.log.2', 'shell.log.3', 'other.log'], 3)
    expect(plan.deletes).toEqual(['shell.log.2', 'shell.log.3'])
    expect(plan.moves.map((move) => move.to)).toEqual(['shell.log.2', 'shell.log.1'])
    expect(rotatedName('shell.log', 2)).toBe('shell.log.2')
  })
})

describe('日志写入（真文件）', () => {
  test('写行带时间戳，size/tail 读回一致', () => {
    const dir = tempDir()
    try {
      const file = join(dir, 'shell.log')
      const sink = createLogSink({ file, now: () => new Date(2026, 9, 11, 10, 0, 0, 0), stdout: () => {} })
      sink.line('[shell] 一')
      sink.line('[shell] 二')
      const content = readFileSync(file, 'utf8')
      expect(content).toBe('2026-10-11 10:00:00.000 [shell] 一\n2026-10-11 10:00:00.000 [shell] 二\n')
      expect(sink.size()).toBe(Buffer.byteLength(content))
      expect(sink.tail(1)).toEqual(['2026-10-11 10:00:00.000 [shell] 二'])
      expect(sink.tail(50)).toHaveLength(2)
      expect(sink.tail(0)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('超过上限先轮转：当前份变 .1，最旧的按份数删', () => {
    const dir = tempDir()
    try {
      const file = join(dir, 'shell.log')
      const sink = createLogSink({ file, maxBytes: 30, keep: 2 })
      sink.write('a'.repeat(20))
      sink.write('\n')
      sink.write('b'.repeat(20))
      sink.write('\n')
      sink.write('c'.repeat(20))
      expect(existsSync(join(dir, 'shell.log'))).toBe(true)
      expect(existsSync(join(dir, 'shell.log.1'))).toBe(true)
      // keep=2 ⇒ 只留当前份 + .1；第三轮把 .1 顶掉成 .2 再删 .2
      expect(existsSync(join(dir, 'shell.log.2'))).toBe(false)
      expect(readFileSync(join(dir, 'shell.log'), 'utf8')).toBe('c'.repeat(20))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('文件被外部灌大：下一次写先重新 stat 再轮转', () => {
    const dir = tempDir()
    try {
      const file = join(dir, 'shell.log')
      const sink = createLogSink({ file, maxBytes: 100, keep: 2, statIntervalMs: 0 })
      sink.write('起点\n')
      // 外部工具（或别的实例）把文件灌过上限：光靠内存记账会看不到
      writeFileSync(file, 'x'.repeat(500))
      sink.write('再来一行\n')
      expect(existsSync(join(dir, 'shell.log.1'))).toBe(true)
      expect(readFileSync(join(dir, 'shell.log'), 'utf8')).toBe('再来一行\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('onRotate 只在真搬家/删文件时回调', () => {
    const dir = tempDir()
    try {
      const events: { moved: number; deleted: number }[] = []
      const file = join(dir, 'shell.log')
      const sink = createLogSink({ file, maxBytes: 10, keep: 2, onRotate: (info) => events.push(info) })
      sink.write('12345678901')
      expect(events).toEqual([]) // 首次写没有旧文件可搬
      sink.write('12345678901')
      expect(events).toEqual([{ moved: 1, deleted: 0 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('describeLogFile 报路径、体积与历史份数；空目录不抛', () => {
    const dir = tempDir()
    try {
      const file = join(dir, 'shell.log')
      writeFileSync(file, 'x'.repeat(12))
      writeFileSync(join(dir, 'shell.log.1'), 'y')
      const info = describeLogFile(file)
      expect(info).toEqual({ path: file, bytes: 12, rotated: 1 })
      expect(describeLogFile(join(dir, 'none.log'))).toEqual({
        path: join(dir, 'none.log'),
        bytes: 0,
        rotated: 0,
      })
      expect(LOG_KEEP).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
