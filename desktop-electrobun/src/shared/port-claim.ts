// 端口认领判定 + token 抠取（旧壳 `runtime/instances.rs` 的 `decide_claim` 与
// `commands.rs` 的 `extract_token_from_url` 的等价物，纯逻辑、无 IO）。
//
// 四分支语义（旧壳 §4.1，见 /tmp/port-mode-contract.md）：
// - free：端口没人听 → 可以拉起；
// - ours：本壳台账里 {profile, port} 的记录还活着 → 复用接入；
// - foreign-web：外部 dsh 占着 web 遗留端口（env > settings.port > 3080）→ 兼容复用；
// - foreign-unknown：其余（别的 profile / 陌生程序）→ 明确报错，**绝不盲目复用也绝不代杀**。

export type ClaimDecision = 'free' | 'ours' | 'foreign-web' | 'foreign-unknown'

export interface ClaimEntry {
  profile: string
  port: number
  /** 该记录对应的进程是否还活着（调用方用 isProcessAlive 算好带进来，保持本模块纯函数）。 */
  alive: boolean
}

export interface DecideClaimInput {
  profile: string
  port: number
  portOpen: boolean
  claims: readonly ClaimEntry[]
  /** web 遗留端口（env `DSH_DESKTOP_PORT` > `settings.port` > 3080）；只对 web profile 生效。 */
  legacyWebPort?: number
}

export function decideClaim(input: DecideClaimInput): ClaimDecision {
  if (!input.portOpen) return 'free'
  const hit = input.claims.find((claim) => claim.profile === input.profile && claim.port === input.port)
  if (hit !== undefined && hit.alive) return 'ours'
  if (input.profile === 'web' && input.port === (input.legacyWebPort ?? 3080)) return 'foreign-web'
  return 'foreign-unknown'
}

/**
 * 从粘贴的 dsh web 启动 URL 里抠 `?token=`（旧壳 `extract_token_from_url`）。
 * 空 / 不是 URL / 没带 token → null；非空但认不出 → 调用方按「未能识别 token」提示。
 */
export function extractTokenFromUrl(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  try {
    const url = new URL(text)
    const token = url.searchParams.get('token')
    return token !== null && token !== '' ? token : null
  } catch {
    return null
  }
}
