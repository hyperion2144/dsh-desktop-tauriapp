/**
 * client 纯函数测试入口（node scripts/test-client.mjs）。
 * 用 esbuild 把 TS 纯函数模块转译到临时目录后动态 import 断言，
 * 不给 client 引入测试框架依赖。目前覆盖 download-intercept 的拦截判定。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = join(root, '.test-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

await build({
  entryPoints: [join(root, 'src/client/download-intercept.ts')],
  outfile: join(tmp, 'download-intercept.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { shouldIntercept, filenameFromAnchor } = await import(join(tmp, 'download-intercept.mjs'))

// ── shouldIntercept：仅 blob:/data: 协议的 a[download] 才接管 ──
assert.equal(shouldIntercept('blob:http://127.0.0.1:3080/uuid', true), true, 'blob 链接应拦截')
assert.equal(shouldIntercept('data:text/plain;base64,SGk=', true), true, 'data 链接应拦截')
assert.equal(shouldIntercept('BLOB:https://h/x', true), true, '协议前缀大小写不敏感')
assert.equal(shouldIntercept('http://127.0.0.1:3080/api/session.export?sessionId=s1', true), false, 'http 直链走 on_download 转交，不拦')
assert.equal(shouldIntercept('https://example.com/f.zip', true), false, 'https 直链不拦')
assert.equal(shouldIntercept('blob:http://h/x', false), false, '无 download 属性不拦（普通导航）')
assert.equal(shouldIntercept(null, true), false, '无 href 不拦')
assert.equal(shouldIntercept(null, false), false, '都缺不拦')

// ── filenameFromAnchor：download 属性优先，回退 URL 尾段 ──
assert.equal(filenameFromAnchor('report.zip', 'blob:http://h/uuid'), 'report.zip', 'download 属性优先')
assert.equal(filenameFromAnchor('  ', 'blob:http://h/uuid'), 'uuid', '空白属性回退 blob 尾段')
assert.equal(filenameFromAnchor(null, 'data:text/plain;base64,xx'), 'download', 'data URL 无路径段回退默认名')
assert.equal(filenameFromAnchor(null, 'blob:http://h/path/file.tar.gz'), 'file.tar.gz', 'URL 尾段含扩展名')
assert.equal(filenameFromAnchor('报告 v1.2.pdf', 'blob:x'), '报告 v1.2.pdf', '中文文件名保留')

rmSync(tmp, { recursive: true, force: true })
console.log('client 纯函数测试：全部通过 ✓')
