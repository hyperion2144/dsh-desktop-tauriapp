// 无窗口入口：普通 bun 直接跑，给缝 ①（进程级黑盒测试）与 CI 用。
//
// 它只依赖 service.ts（不 import electrobun），所以在无显示器、无 CEF 的机器上也能起壳的
// 服务面，然后被真 HTTP/WS 打。CI 门禁据此从 cargo test 换成「bun test + 缝 ①」。
//
//   bun run src/bun/serve.ts
//   DSH_HOME=/tmp/shell-home DSH_SHELL_PAGE_PORT=6391 bun run src/bun/serve.ts

import { startService } from './service.ts'

const clientVersion = process.env.DSH_SHELL_CLIENT_VERSION ?? '0.1.0'
const service = await startService({ clientVersion, noWindow: true })
// 这一行是缝 ① 的握手：测试读 stdout 拿 origin / token / 上游，再自己去打 HTTP。
console.log(`SHELL-READY ${JSON.stringify(service.state)}`)

let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  try {
    service.stop()
  } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
