import { describe, expect, test } from 'bun:test'
import { navRulesFor } from '../src/shared/nav-rules.ts'

describe('navRulesFor（D1，Electrobun navigationRules）', () => {
  test('阻断在前、白名单在后（最后命中赢 ⇒ 白名单放行、站外被拦）', () => {
    const rules = navRulesFor({ origin: 'http://127.0.0.1:6393' })
    expect(rules[0]).toBe('^*')
    expect(rules).toContain('http://127.0.0.1:6393/*')
    expect(rules.indexOf('^*')).toBeLessThan(rules.indexOf('http://127.0.0.1:6393/*'))
  })
  test('空 origin 被过滤；extraOrigins 一并放行', () => {
    const rules = navRulesFor({ origin: '', extraOrigins: ['https://dsh.example.cn'] })
    expect(rules).toEqual(['^*', 'https://dsh.example.cn/*'])
  })
})
