// 无窗口入口：普通 bun 直接跑，给缝 ①（进程级黑盒测试）与 CI 用。
//
// 它只依赖 service.ts（不 import electrobun），所以在无显示器、无 CEF 的机器上也能起壳的
// 服务面，然后被真 HTTP/WS 打。CI 门禁据此从 cargo test 换成「bun test + 缝 ①」。
//
//   bun run src/bun/serve.ts
//   DSH_HOME=/tmp/shell-home DSH_SHELL_PAGE_PORT=6391 bun run src/bun/serve.ts
//
// 只解析运行时选中、不起壳也不起宿主（探针 / CI 用）：
//   DSH_SHELL_RESOLVE_ONLY=1 DSH_HOME=/tmp/x bun run src/bun/serve.ts

import { startService } from './service.ts'
import { layout } from './runtime.ts'

const clientVersion = process.env.DSH_SHELL_CLIENT_VERSION ?? '0.1.0'

// 只解析：把选中结果打成一行 JSON 就退出（不起宿主、不建窗口、不写状态文件）。
if (process.env.DSH_SHELL_RESOLVE_ONLY === '1') {
  const resolved = layout()
  console.log(
    `SHELL-LAYOUT ${JSON.stringify({
      kind: resolved.runtimeKind,
      note: resolved.runtimeNote,
      runtimeDir: resolved.runtimeDir,
      version: resolved.runtimeVersion,
      dshLibDir: resolved.dshLibDir,
      distDir: resolved.distDir,
      profile: resolved.profile,
      appSupport: resolved.appSupport,
    })}`
  )
  process.exit(0)
}
const service = await startService({ clientVersion, noWindow: true })
// 这一行是缝 ① 的握手：测试读 stdout 拿 origin / token / 上游，再自己去打 HTTP。
console.log(`SHELL-READY ${JSON.stringify(service.state)}`)

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  try {
    // 与 index.ts 同语义：等宿主真的退出再走，否则它会变成占着会话的孤儿。
    await service.stop()
  } catch (error) {
    console.error(`[shell] 停止服务面失败：${String(error)}`)
  }
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
