// dsh 宿主进程（官方 apps/desktop-host/src/index.ts 的等价物，Bun 版）。
//
// 契约（与官方一致）：
//   loadProfileDirectory('dsh', projectDir, installAnchor) → runProfile({ ..., args: ['--no-open','--host','127.0.0.1','--port','0'] })
//   → 取 ctx.webServer.port 与 ctx.connection.authenticatedUrl(base) → 向壳报告 { type:'ready', url, injections }
//   injections = ctx.webServer.collectIndexInjections()（进程内取，绝不走 HTTP 面——页面此时还没有 Cordis 树）
//
// 端口由本进程自己拿（--port 0），壳不再猜端口：这是与 Tauri 版最大的差别之一。
//
// 用法：bun --no-install --preload <bun-preload.mjs> dsh-host.mjs <dshLibDir> <profile> [fresh|existing]
// 环境：DSH_HOME 由壳注入（buildChildEnv），另有 DSH_CLIENT_VERSION 等（见 src/shared/child-env.ts）

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { watchParent } from './parent-watch.mjs'

const [libDir, profileName = 'desktop', mode = 'existing'] = process.argv.slice(2)
if (libDir === undefined) {
  console.error('[host] 缺少 dsh lib 目录参数')
  process.exit(2)
}

const runtimeDir = join(libDir, '..', '..', '..', '..')
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const require = createRequire(join(libDir, 'bin.js'))

const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { runProfile } = await import(pathToFileURL(join(libDir, 'profile-boot.js')).href)

console.log(
  `[host] bun = ${process.versions.bun} | profile = ${profileName} | DSH_HOME = ${process.env.DSH_HOME ?? '(unset)'} | DSH_CLIENT_VERSION = ${process.env.DSH_CLIENT_VERSION ?? '(unset)'}`,
)

const application = runProfile({
  environment: boot.loadLayeredEnv('dsh'),
  profile: profileName,
  ...(mode === 'fresh' ? { fromDefaultProfile: 'web' } : {}),
  patchFiles: [],
  args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
})

// 父进程看门狗：壳崩溃/被 SIGKILL/退出后，我们会变成孤儿继续占着会话——
// 所以由子进程反过来盯着壳（DSH_SHELL_PARENT_PID 由壳注入）。
watchParent({
  parentPid: Number(process.env.DSH_SHELL_PARENT_PID ?? '0'),
  onDead: (reason) => {
    console.error(`[host] 壳已不在（${reason}），宿主随之退出`)
    shutdown('parent-gone')
  },
})

const { ctx } = await application

const base = `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`
const url = ctx.connection.authenticatedUrl(base)
const injections = ctx.webServer.collectIndexInjections()
console.log(`[host] webServer.port = ${String(ctx.webServer.port)} | injections = ${String(injections.length)}`)
console.log(`HOST-READY ${JSON.stringify({ type: 'ready', url, injections })}`)

// 壳要求退出时，把关闭交给运行时（对齐官方 shutdown 语义）。
// 用函数声明（会提升）：父进程看门狗可能在 await 之前就触发。
let disposed = false
function shutdown(reason = 'signal') {
  if (disposed) return
  disposed = true
  console.log(`[host] 退出（${reason}）`)
  try {
    application.dispose?.()
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('message', (message) => {
  if (message === 'shutdown') shutdown()
})
