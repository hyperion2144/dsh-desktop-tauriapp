// 端口优先级链与认领台账（规格第 7 条 / R7：页面 origin 固定端口，被占顺延）
//
// 为什么必须固定：loopback origin 就是 localStorage / IndexedDB / Cache 的隔离键。
// #219 实测——随机端口时每次启动都是新 origin，上一次写入的值读不回来（探针 `lsPrev === null`）；
// 固定端口二次启动能读到（`lsPrev` 有值）⇒ 页面 origin 必须跨启动稳定。
// 被占时顺延（origin 随之改变，由调用方决定是否提示），台账记「谁占了哪个端口」，
// 进程死掉后由 pruneClaims 收复，避免台账越长越脏。

export const PAGE_PORT_BASE = 6390
export const PAGE_PORT_SPAN = 40
export const MIN_PORT = 1024
export const MAX_PORT = 65535

export interface PortClaim {
  profile: string
  /** 页面 origin 端口（要跨启动稳定，进台账） */
  port: number
  /** 数据面/反代监听端口（随机即可，仅供诊断） */
  dataPort?: number
  /** 手机访问 lane 端口（同一 profile 的上游/页面端口互不重复） */
  lanePort?: number
  pid: number
  startedAt: string
}

export function isValidPort(port: number | undefined | null): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

/**
 * 优先级链：显式指定 → 台账里本 profile 上次的端口 → 从 base 起顺延。
 * 三段都要求 isFree 成立；全占满返回 null（调用方决定是报错还是换基端口）。
 */
export function choosePort(input: {
  requested?: number | undefined
  lastClaimed?: number | undefined
  base?: number
  span?: number
  isFree: (port: number) => boolean
}): number | null {
  const base = input.base ?? PAGE_PORT_BASE
  const span = input.span ?? PAGE_PORT_SPAN
  if (isValidPort(input.requested) && input.isFree(input.requested)) return input.requested
  if (isValidPort(input.lastClaimed) && input.isFree(input.lastClaimed)) return input.lastClaimed
  for (let port = base; port < base + span; port += 1) {
    if (input.isFree(port)) return port
  }
  return null
}

function isClaim(value: unknown): value is PortClaim {
  if (typeof value !== 'object' || value === null) return false
  const claim = value as Partial<PortClaim>
  return typeof claim.profile === 'string' && isValidPort(claim.port) && typeof claim.pid === 'number'
}

/** 台账是磁盘上的共享文件，坏了当空表处理（不因为一条脏记录起不来）。 */
export function parseClaims(raw: string): PortClaim[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isClaim)
  } catch {
    return []
  }
}

export function claimFor(claims: PortClaim[], profile: string): PortClaim | undefined {
  return claims.find((claim) => claim.profile === profile)
}

export function upsertClaim(claims: PortClaim[], claim: PortClaim): PortClaim[] {
  const next = claims.filter((item) => item.profile !== claim.profile)
  next.push(claim)
  next.sort((a, b) => a.port - b.port)
  return next
}

export function releaseClaim(claims: PortClaim[], profile: string): PortClaim[] {
  return claims.filter((item) => item.profile !== profile)
}

/** 持有进程已死的条目一律收复。 */
export function pruneClaims(claims: PortClaim[], isAlive: (pid: number) => boolean): PortClaim[] {
  return claims.filter((claim) => isAlive(claim.pid))
}
