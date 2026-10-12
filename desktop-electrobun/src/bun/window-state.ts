// 窗口位置与尺寸的记忆（纯逻辑，缝 ② 可测）。
//
// 旧 Tauri 壳用 `tauri-plugin-window-state` 干这件事；Electrobun 没有对应物，
// 所以自己存一个 JSON。真正容易出错的是「下次启动时显示器没了」——
// 外接屏拔掉后把窗口还原到不存在的坐标，窗口就永远看不见了，所以落盘值必须过一遍校验。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface WindowFrame {
  x: number
  y: number
  width: number
  height: number
}

/** 显示器可见区域（Electrobun Screen API 的形状）。 */
export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 860
export const MIN_WINDOW_WIDTH = 900
export const MIN_WINDOW_HEIGHT = 560
/** 至少要露出这么多像素才算「看得见」，否则视为跑到屏幕外。 */
export const MIN_VISIBLE_EDGE = 120

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

export function parseWindowFrame(text: string): WindowFrame | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const x = toInt(record.x)
    const y = toInt(record.y)
    const width = toInt(record.width)
    const height = toInt(record.height)
    if (x === null || y === null || width === null || height === null) return null
    if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return null
    return { x, y, width, height }
  } catch {
    return null
  }
}

/** 窗口与某块屏幕是否有足够重叠（不要求整窗在屏内，标题栏拖得到即可）。 */
export function isFrameVisible(frame: WindowFrame, displays: readonly DisplayBounds[], minEdge = MIN_VISIBLE_EDGE): boolean {
  return displays.some((display) => {
    const overlapX = Math.min(frame.x + frame.width, display.x + display.width) - Math.max(frame.x, display.x)
    const overlapY = Math.min(frame.y + frame.height, display.y + display.height) - Math.max(frame.y, display.y)
    return overlapX >= minEdge && overlapY >= minEdge
  })
}

/**
 * 落盘值 → 可用的窗口几何；不可用（越界 / 太小 / 坏数据）返回 null，让调用方用默认值居中开。
 * 尺寸按主屏夹取：换小屏后不该还原出一个比屏幕还大的窗口。
 */
export function sanitizeFrame(frame: WindowFrame | null, displays: readonly DisplayBounds[]): WindowFrame | null {
  if (frame === null) return null
  if (displays.length === 0) return null
  const primary = displays[0] as DisplayBounds
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(frame.width, primary.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(frame.height, primary.height))
  const candidate: WindowFrame = { x: frame.x, y: frame.y, width, height }
  if (!isFrameVisible(candidate, displays)) return null
  return candidate
}

export function readWindowFrame(file: string): WindowFrame | null {
  if (!existsSync(file)) return null
  try {
    return parseWindowFrame(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeWindowFrame(file: string, frame: WindowFrame): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(frame, null, 2)}\n`)
  } catch {}
}

export function clearWindowFrame(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {}
}
