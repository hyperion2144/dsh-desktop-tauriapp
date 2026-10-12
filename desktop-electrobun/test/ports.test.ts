import { describe, expect, test } from 'bun:test'
import {
  PAGE_PORT_BASE,
  choosePort,
  claimFor,
  isValidPort,
  parseClaims,
  pruneClaims,
  releaseClaim,
  upsertClaim,
  type PortClaim,
} from '../src/shared/ports.ts'

const free = (taken: number[]) => (port: number) => !taken.includes(port)

describe('端口优先级链（页面 origin 必须跨启动稳定）', () => {
  test('显式指定优先，且只在空闲时采用', () => {
    expect(choosePort({ requested: 7000, lastClaimed: 6500, isFree: free([]) })).toBe(7000)
    expect(choosePort({ requested: 7000, lastClaimed: 6500, isFree: free([7000]) })).toBe(6500)
  })

  test('其次用台账里本 profile 上次的端口（这是 origin 稳定的来源）', () => {
    expect(choosePort({ lastClaimed: 6501, isFree: free([]) })).toBe(6501)
    expect(choosePort({ lastClaimed: 6501, isFree: free([6501]) })).toBe(PAGE_PORT_BASE)
  })

  test('都被占时从基端口顺延，并跳过被占的洞', () => {
    const taken = [PAGE_PORT_BASE, PAGE_PORT_BASE + 1, PAGE_PORT_BASE + 3]
    expect(choosePort({ isFree: free(taken) })).toBe(PAGE_PORT_BASE + 2)
  })

  test('池满返回 null（调用方决定报错还是换基端口）', () => {
    const all = Array.from({ length: 5 }, (_, index) => PAGE_PORT_BASE + index)
    expect(choosePort({ base: PAGE_PORT_BASE, span: 5, isFree: free(all) })).toBeNull()
  })

  test('非法端口值不参与选择（0 / 80 / 65536 / 小数）', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(80)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(6390.5)).toBe(false)
    expect(isValidPort(undefined)).toBe(false)
    expect(isValidPort(6390)).toBe(true)
    expect(choosePort({ requested: 80, lastClaimed: 70000, isFree: free([]) })).toBe(PAGE_PORT_BASE)
  })
})

describe('认领台账', () => {
  const claim = (profile: string, port: number, pid = 100): PortClaim => ({
    profile,
    port,
    pid,
    startedAt: '2026-10-11T00:00:00.000Z',
  })

  test('坏 JSON / 非数组 / 缺字段一律降级，不让壳起不来', () => {
    expect(parseClaims('not json')).toEqual([])
    expect(parseClaims('{"profile":"desktop"}')).toEqual([])
    expect(parseClaims('[{"profile":"desktop","port":"6390","pid":1}]')).toEqual([])
    expect(parseClaims(JSON.stringify([claim('desktop', 6390)]))).toHaveLength(1)
  })

  test('同 profile 覆盖而不是追加', () => {
    const list = upsertClaim(upsertClaim([], claim('desktop', 6390)), claim('desktop', 6391))
    expect(list).toHaveLength(1)
    expect(claimFor(list, 'desktop')?.port).toBe(6391)
  })

  test('释放后本 profile 不再占端口', () => {
    const list = upsertClaim(upsertClaim([], claim('desktop', 6390)), claim('web', 6391))
    const next = releaseClaim(list, 'desktop')
    expect(claimFor(next, 'desktop')).toBeUndefined()
    expect(claimFor(next, 'web')?.port).toBe(6391)
  })

  test('持有进程已死的条目被收复', () => {
    const list = [claim('desktop', 6390, 111), claim('web', 6391, 222)]
    expect(pruneClaims(list, (pid) => pid === 111)).toEqual([claim('desktop', 6390, 111)])
  })
})
