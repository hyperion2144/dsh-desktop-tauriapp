import { describe, expect, test } from 'bun:test'
import {
  isSelfMigrate,
  isValidProfileName,
  profileDialogHtml,
} from '../src/bun/profile-dialog.ts'

describe('isValidProfileName', () => {
  test('合法名', () => {
    expect(isValidProfileName('desktop')).toBe(true)
    expect(isValidProfileName('a')).toBe(true)
    expect(isValidProfileName('my-work-2')).toBe(true)
  })
  test('非法名', () => {
    expect(isValidProfileName('')).toBe(false)
    expect(isValidProfileName('-lead')).toBe(false)
    expect(isValidProfileName('Big')).toBe(false)
    expect(isValidProfileName('a/b')).toBe(false)
    expect(isValidProfileName('..')).toBe(false)
  })
})

describe('isSelfMigrate', () => {
  test('同名为真，空串不算', () => {
    expect(isSelfMigrate('desktop', 'desktop')).toBe(true)
    expect(isSelfMigrate('', '')).toBe(false)
    expect(isSelfMigrate('desktop', 'web')).toBe(false)
  })
})

describe('profileDialogHtml', () => {
  test('create：只有目标输入，提交到 /__shell__/profile-op', () => {
    const html = profileDialogHtml('create', ['desktop'])
    expect(html).toContain('/__shell__/profile-op')
    expect(html).toContain("op: 'create'")
    expect(html).not.toContain('id="source"')
  })
  test('migrate：源下拉与覆盖确认，profile 名经转义', () => {
    const html = profileDialogHtml('migrate', ['desktop', '<x>"y"'])
    expect(html).toContain("op: 'migrate'")
    expect(html).toContain('id="source"')
    expect(html).toContain('id="overwrite"')
    expect(html).toContain('&lt;x&gt;&quot;y&quot;')
  })
})
