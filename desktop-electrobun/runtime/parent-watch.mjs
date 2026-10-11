// 父进程看门狗：壳（Electrobun 主进程）不在了，本进程必须跟着退出。
//
// 为什么需要它：壳崩溃或被 SIGKILL 时，内核把子进程交给 launchd 收养（ppid 变 1），
// 壳自己那条 SIGTERM 路径根本来不及跑，于是 dsh 宿主会一直活着占着会话——实机现象
// 就是「得手动 kill 掉旧进程，新壳才能用会话」。只有子进程反过来盯着壳才挡得住。
//
// 判据（任一成立即认为父没了）：
//   1. process.ppid === 1 —— 已被 launchd 收养，父进程尸体都凉了
//   2. process.kill(parentPid, 0) 抛 ESRCH —— 父 pid 已不存在
// EPERM 说明进程还在（只是信号权限不同），不算死。
//
// 约定：DSH_SHELL_PARENT_PID 由壳注入（见 src/shared/child-env.ts）。没传/非法 ⇒ 不启用
// （例如手工 `bun dsh-host.mjs` 起宿主时，父就是终端，不需要看门狗）。

/** 纯判据，便于单测：返回 null（还活着）/ 'reparented' / 'gone'。 */
export function parentWatchReason({ parentPid, ppid, alive }) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null
  if (ppid === 1) return 'reparented'
  if (alive === false) return 'gone'
  return null
}

/** pid 是否存活（EPERM 视为存活）。 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 盯着 parentPid；父没了就调用一次 onDead(reason)。
 * 返回停止函数（幂等）。定时器 unref，不阻止本进程自然退出。
 */
export function watchParent(options = {}) {
  const {
    parentPid = 0,
    intervalMs = 2000,
    onDead,
    ppid = () => process.ppid,
    alive = isProcessAlive,
    setTimer = setInterval,
    clearTimer = clearInterval,
  } = options
  if (!Number.isInteger(parentPid) || parentPid <= 0) return () => {}
  let stopped = false
  const handle = setTimer(() => {
    if (stopped) return
    const reason = parentWatchReason({ parentPid, ppid: ppid(), alive: alive(parentPid) })
    if (reason === null) return
    stopped = true
    clearTimer(handle)
    onDead?.(reason)
  }, intervalMs)
  handle?.unref?.()
  return () => {
    if (stopped) return
    stopped = true
    clearTimer(handle)
  }
}
