import { describe, expect, test } from 'bun:test'
import { confirmModalScript, INPUT_CONFIRM_ENDPOINT } from '../src/bun/input-modal.ts'

describe('confirmModalScript（F12）', () => {
  test('端点与 flow 都进了脚本，flow 经 JSON 转义', () => {
    const script = confirmModalScript({ flow: 'reg"1', title: '冲突', body: '指向 x' })
    expect(script).toContain(INPUT_CONFIRM_ENDPOINT)
    expect(script).toContain(JSON.stringify('reg"1'))
    expect(script).toContain(JSON.stringify('指向 x'))
  })
  test('确认回填 force、取消/ESC 回填空串，POST 后移除遮罩', () => {
    const script = confirmModalScript({ flow: 'f', title: 't', body: 'b', okLabel: '覆盖' })
    expect(script).toContain("submit('force')")
    expect(script).toContain("submit('')")
    expect(script).toContain("'Escape'")
    expect(script).toContain('overlay.remove()')
    expect(script).toContain(JSON.stringify('覆盖'))
  })
})
