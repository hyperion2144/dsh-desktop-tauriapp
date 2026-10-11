import { describe, expect, test } from 'bun:test'
import { FALLBACK_LOCALE, localeCandidates, normalizeLocale } from '../src/bun/locale.ts'

describe('系统语言归一（页面语言就靠它）', () => {
  test('AppleLocale 形式（下划线）转 BCP-47', () => {
    expect(normalizeLocale('zh_CN')).toBe('zh-CN')
    expect(normalizeLocale('en_US')).toBe('en-US')
    expect(normalizeLocale('ja_JP')).toBe('ja-JP')
  })

  test('带 codeset 与修饰符的 POSIX 写法', () => {
    expect(normalizeLocale('zh_CN.UTF-8')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans_CN.UTF-8@modifier')).toBe('zh-Hans-CN')
    expect(normalizeLocale('en_US.UTF-8')).toBe('en-US')
  })

  test('脚本子标签大小写规整（zh-hans-cn → zh-Hans-CN）', () => {
    expect(normalizeLocale('zh-hans-cn')).toBe('zh-Hans-CN')
  })

  test('C / POSIX / 空值视为未设置', () => {
    expect(normalizeLocale('C')).toBeNull()
    expect(normalizeLocale('POSIX')).toBeNull()
    expect(normalizeLocale('  ')).toBeNull()
    expect(normalizeLocale('9x')).toBeNull()
  })

  test('候选表：主语言 + 基语言 + en-US/en，且去重', () => {
    expect(localeCandidates('zh-CN')).toEqual(['zh-CN', 'zh', 'en-US', 'en'])
    expect(localeCandidates('en-US')).toEqual(['en-US', 'en'])
    expect(FALLBACK_LOCALE).toBe('en-US')
  })
})
