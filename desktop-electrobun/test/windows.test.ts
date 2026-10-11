import { describe, expect, test } from 'bun:test'

import { closeAction, offsetFrame, planWindowOpen, windowKey } from '../src/shared/window-targets.ts'

// 多窗口的纯逻辑（`desktop/src-tauri/src/ui/multiwin.rs` 的等价物）。
// 真起窗口的那部分只能在实机上看（缝 ③/手动），这里锁的是语义：谁聚焦、谁关、窗口落哪。

describe('多窗口纯逻辑', () => {
  test('窗口绑定键就是把 profile 前缀化', () => {
    expect(windowKey('desktop')).toBe('profile-desktop')
    expect(windowKey('web')).toBe('profile-web')
  })

  test('已开窗的 profile 点了是聚焦，没开的是建窗', () => {
    expect(planWindowOpen('web', ['desktop', 'web'])).toBe('focus')
    expect(planWindowOpen('web', ['desktop'])).toBe('create')
    expect(planWindowOpen('web', [])).toBe('create')
  })

  test('主窗关窗回托盘，其余窗口只销毁 UI（实例继续跑）', () => {
    expect(closeAction('desktop', 'desktop')).toBe('hide-to-tray')
    expect(closeAction('web', 'desktop')).toBe('destroy')
    expect(closeAction('desktop', 'web')).toBe('destroy')
  })

  test('第一个窗口用记下来的几何（原对象不许被改）', () => {
    const frame = { x: 10, y: 20, width: 800, height: 600 }
    expect(offsetFrame(frame, 0)).toBe(frame)
    expect(offsetFrame(frame, -1)).toBe(frame)
    expect(frame).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })

  test('后续窗口每次右下偏移 26pt，尺寸不动', () => {
    const frame = { x: 10, y: 20, width: 800, height: 600 }
    expect(offsetFrame(frame, 1)).toEqual({ x: 36, y: 46, width: 800, height: 600 })
    expect(offsetFrame(frame, 3)).toEqual({ x: 88, y: 98, width: 800, height: 600 })
  })
})
