// #219 验收点 ⑤ 与「启动 dsh / 取 cookie 对齐官方」验证：
// 与官方 apps/desktop-host/src/index.ts 同构的最小 host（Bun 版）——
// loadProfileDirectory/fromDefaultProfile -> runProfile(--port 0) -> 报告 {url, injections}。
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [libDir, profileName = 'spike', mode = 'fresh'] = process.argv.slice(2)
const runtimeDir = join(libDir, '..', '..', '..', '..')
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const require = createRequire(join(libDir, 'bin.js'))
const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { runProfile } = await import(pathToFileURL(join(libDir, 'profile-boot.js')).href)

console.log('[host] bun =', process.versions.bun, '| profile =', profileName, '| DSH_HOME =', process.env.DSH_HOME)
const application = runProfile({
  environment: boot.loadLayeredEnv('dsh'),
  profile: profileName,
  ...(mode === 'fresh' ? { fromDefaultProfile: 'web' } : {}),
  patchFiles: [],
  args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
})
const { ctx } = await application
if (process.env.SPIKE_CRED_PROBE === '1') {
  const { credentialRef } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials')).href)
  for (const name of ['COMMANDCODE_API_KEY', 'DEEPSEEK_API_KEY', 'MINIMAX_CN_API_KEY']) {
    try {
      const d = await ctx.credentials.describe(credentialRef(name))
      console.log('[cred]', name, JSON.stringify(d))
    } catch (e) { console.log('[cred]', name, 'ERR', String(e).slice(0, 160)) }
  }
}
const base = `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`
const url = ctx.connection.authenticatedUrl(base)
const injections = ctx.webServer.collectIndexInjections()
console.log('[host] webServer.port =', ctx.webServer.port, '| injections =', injections.length)
console.log('HOST-READY ' + JSON.stringify({ type: 'ready', url, injections }))
