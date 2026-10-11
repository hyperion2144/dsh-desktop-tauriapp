/**
 * 每视图授权（#220 决策 12 的「授权层重建」）。
 *
 * 问题：旧壳的 Tauri IPC 由 capability 文件按**窗口**发权限（`capabilities/default.json` 75 条 +
 * `remote-desktop.json` 74 条）。新壳把页面桥（`__TAURI_INTERNALS__.invoke`）统一接到
 * `POST /__shell__/rpc`，而**所有窗口同源**（同一个 loopback origin）——只看 Origin 与 cookie
 * 分不出「这是主窗、还是我们贴进来的网页 guest」。
 *
 * 做法：主进程给每个视图发一枚随机 view token，随该视图的 preload 注入页面；页面桥每次请求带上
 * `x-dsh-shell-view`。壳侧查表得到视图种类，再按种类放行命令：
 *   - `shell`：壳自己的页面（主窗 / 各 profile 窗口）——全部命令；
 *   - `guest`：贴进来的网页（侧边栏浏览器、远程窗口）——**任何**壳命令都不放行，只留「报日志」
 *     这一条；它仍然要能开外链、弹右键菜单（那两条端点只认 token，不认命令白名单）。
 *
 * 为什么要按种类白名单而不是「不给 guest 装桥」：装了桥的页面就是不可信页面，白名单是最后一道
 * 闸（旧壳对应的是「远程窗口不装 dshDesktop 载体」，见 docs/research/shell-capability-inventory.md:72）。
 */

/** 视图种类：壳自己的页面 / 外来网页。 */
export type ViewKind = 'shell' | 'guest'

/** 页面桥带 token 的请求头。 */
export const VIEW_TOKEN_HEADER = 'x-dsh-shell-view'

/**
 * guest 视图唯一放行的命令：报日志。
 * 其余一律拒绝——包括 `open_external` 这类看似无害的（外链有专门的端点，不走命令表）。
 */
export const GUEST_ALLOWED_COMMANDS: readonly string[] = ['log_console', 'log_diag']

export interface ViewGrant {
  /** 随机 token（页面桥带回来） */
  token: string
  kind: ViewKind
  /** 视图所属 profile（诊断用；授权判断目前不看它） */
  profile: string
  /** 人读的标签（日志里说清是谁） */
  label: string
}

export interface ViewRegistry {
  issue(kind: ViewKind, profile: string, label: string): ViewGrant
  lookup(token: string | null | undefined): ViewGrant | null
  revoke(token: string): void
  /** 关窗时按标签批量撤销（一个窗口可能有主/子多个视图） */
  revokeLabel(label: string): number
  list(): ViewGrant[]
}

/** 命令是否允许来自这种视图。 */
export function isCommandAllowed(kind: ViewKind, command: string): boolean {
  if (kind === 'shell') return true
  return GUEST_ALLOWED_COMMANDS.includes(command)
}

/** 拒绝时给页面与日志看的一句话。 */
export function denyReason(kind: ViewKind, command: string): string {
  return `命令 ${command} 不允许来自 ${kind === 'guest' ? 'guest（外来网页）' : kind} 视图`
}

/**
 * 视图台账。token 生成可注入（测试里给确定性序列；壳里用 `crypto.randomUUID`）。
 * 纯内存：壳重启即失效，没有持久化面（旧壳的 capability 是静态的，这里每次都重新发）。
 */
export function createViewRegistry(randomToken: () => string = defaultToken): ViewRegistry {
  const grants = new Map<string, ViewGrant>()
  return {
    issue(kind, profile, label) {
      const grant: ViewGrant = { token: randomToken(), kind, profile, label }
      grants.set(grant.token, grant)
      return grant
    },
    lookup(token) {
      if (token === null || token === undefined || token === '') return null
      return grants.get(token) ?? null
    },
    revoke(token) {
      grants.delete(token)
    },
    revokeLabel(label) {
      let removed = 0
      for (const [token, grant] of grants) {
        if (grant.label === label) {
          grants.delete(token)
          removed += 1
        }
      }
      return removed
    },
    list() {
      return [...grants.values()]
    },
  }
}

function defaultToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
