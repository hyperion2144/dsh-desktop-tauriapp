import { describe, expect, test } from 'bun:test'
import { decide, isCrossSite, normalizeRel, stripToken } from '../src/shared/admission.ts'
import { contentTypeFor, isNoContentAsset, resolveAsset } from '../src/shared/asset-path.ts'
import { resolve } from 'node:path'
import { buildChildEnv, assertChildEnv, missingEnvKeys, CHILD_RESOURCE_CONDITIONS } from '../src/shared/child-env.ts'
import { scrubRequestHeaders, scrubResponseHeaders, shouldNoStore } from '../src/shared/headers.ts'

const SELF = 'http://127.0.0.1:6390'
const TOKEN = 'tok-abc123'

describe('准入：两类准入 + 壳自答端点', () => {
  test('文档与静态资产必须带每次启动的 token 前缀', () => {
    expect(stripToken(`/${TOKEN}/assets/index-abc.js`, TOKEN)).toBe('/assets/index-abc.js')
    expect(stripToken(`/${TOKEN}/`, TOKEN)).toBe('/')
    expect(stripToken(`/${TOKEN}`, TOKEN)).toBe('/')
    expect(stripToken('/assets/index-abc.js', TOKEN)).toBeNull()
    expect(stripToken('/tok-other/', TOKEN)).toBeNull()
    expect(stripToken('/tok-abc1234/', TOKEN)).toBeNull()
  })

  test('数据面走根绝对路径，不要求 token（要求就全站 404）', () => {
    const decision = decide({ pathname: '/api/session/modelCatalog', token: TOKEN, selfOrigin: SELF })
    expect(decision.kind).toBe('data')
    expect(decision.rel).toBe('/api/session/modelCatalog')
  })

  test('文档类补成目录首页', () => {
    expect(decide({ pathname: `/${TOKEN}/`, token: TOKEN, selfOrigin: SELF }).rel).toBe('/index.html')
    expect(decide({ pathname: `/${TOKEN}/sub/`, token: TOKEN, selfOrigin: SELF }).rel).toBe('/sub/index.html')
    expect(normalizeRel('')).toBe('/index.html')
  })

  test('壳自答端点单独成类，但仍须同源', () => {
    expect(decide({ pathname: '/__shell__/health', token: TOKEN, selfOrigin: SELF }).kind).toBe('shell')
    const crossSite = decide({
      pathname: '/__shell__/health',
      token: TOKEN,
      selfOrigin: SELF,
      origin: 'https://evil.example',
    })
    expect(crossSite.kind).toBe('reject')
    expect(crossSite.status).toBe(403)
  })

  test('跨站判据：Sec-Fetch-Site 优先，Origin 兜底', () => {
    expect(isCrossSite({ secFetchSite: 'same-origin', origin: SELF, selfOrigin: SELF })).toBe(false)
    expect(isCrossSite({ secFetchSite: 'cross-site', selfOrigin: SELF })).toBe(true)
    expect(isCrossSite({ origin: 'http://127.0.0.1:9999', selfOrigin: SELF })).toBe(true)
    expect(isCrossSite({ origin: null, secFetchSite: null, selfOrigin: SELF })).toBe(false)
  })

  test('插件脚本走令牌前缀：转发用 stripped（/plugins/），静态查找才用补过 index.html 的 rel', () => {
    expect(decide({ pathname: '/smooth-stream/mount', token: TOKEN, selfOrigin: SELF }).kind).toBe('data')
    const url = new URL(`http://127.0.0.1:6390/${TOKEN}/plugins/??a/client.js&rev=x`)
    expect(url.pathname).toBe(`/${TOKEN}/plugins/`)
    expect(url.search).toBe('??a/client.js&rev=x')
    const plugin = decide({ pathname: url.pathname, token: TOKEN, selfOrigin: SELF })
    expect(plugin.kind).toBe('document')
    // 转发必须用 stripped（不补 index.html）：/plugins/ 靠查询串寻址，补了就 404
    expect(plugin.stripped).toBe('/plugins/')
    expect(plugin.rel).toBe('/plugins/index.html')
    expect(decide({ pathname: `/${TOKEN}/sub/`, token: TOKEN, selfOrigin: SELF }).stripped).toBe('/sub/')
  })
})

describe('静态资产解析（静态优先 + 穿越防护）', () => {
  const dist = '/tmp/dist'

  test('正常路径解析到 dist 之内', () => {
    // 期望值用 resolve 算，而不是写死 `/tmp/...`：Windows 上 dist 根会被补成盘符路径
    expect(resolveAsset(dist, '/assets/index-abc.js')).toBe(resolve(dist, 'assets/index-abc.js'))
  })

  test('拒绝穿越、反斜杠、NUL、非绝对路径与编码绕过', () => {
    expect(resolveAsset(dist, '/../../etc/passwd')).toBeNull()
    expect(resolveAsset(dist, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveAsset(dist, '/assets\\..\\..\\etc')).toBeNull()
    expect(resolveAsset(dist, '/a\0b')).toBeNull()
    expect(resolveAsset(dist, 'assets/index.js')).toBeNull()
    expect(resolveAsset(dist, '/')).toBeNull()
  })

  test('MIME 表覆盖前端用到的几类', () => {
    expect(contentTypeFor('/x/index.html')).toContain('text/html')
    expect(contentTypeFor('/x/index-Dp57FHwW.js')).toContain('text/javascript')
    expect(contentTypeFor('/x/index-CyN1a9tV.css')).toContain('text/css')
    expect(contentTypeFor('/x/manifest.webmanifest')).toContain('manifest')
    expect(contentTypeFor('/x/unknown.bin')).toBe('application/octet-stream')
  })

  test('源映射按现状协议不变量走 204', () => {
    expect(isNoContentAsset('/assets/index-abc.js.map')).toBe(true)
    expect(isNoContentAsset('/assets/index-abc.js')).toBe(false)
  })
})

describe('转发头（壳持有 cookie）', () => {
  test('出站剥掉 host/origin/cookie，再塞壳持有的 cookie 与上游 authority', () => {
    const input = new Headers({
      host: '127.0.0.1:6390',
      origin: SELF,
      cookie: 'dsh-auth-x=1',
      'sec-fetch-site': 'same-origin',
      accept: 'application/json',
    })
    const out = scrubRequestHeaders(input, { cookie: 'dsh-auth-real=1', authority: '127.0.0.1:55600' })
    expect(out.get('host')).toBe('127.0.0.1:55600')
    expect(out.get('cookie')).toBe('dsh-auth-real=1')
    expect(out.get('origin')).toBeNull()
    expect(out.get('sec-fetch-site')).toBeNull()
    expect(out.get('accept')).toBe('application/json')
  })

  test('响应剥掉 set-cookie 与 hop-by-hop，/plugins/* 与 /api/* 补 no-store', () => {
    const upstream = new Headers({
      'set-cookie': 'dsh-auth-real=1; HttpOnly',
      'content-length': '123',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
    })
    const out = scrubResponseHeaders(upstream, { pathname: '/api/session/modelCatalog' })
    expect(out.get('set-cookie')).toBeNull()
    expect(out.get('content-length')).toBeNull()
    expect(out.get('transfer-encoding')).toBeNull()
    expect(out.get('content-type')).toBe('application/json')
    expect(out.get('cache-control')).toBe('no-store')
    expect(shouldNoStore('/plugins/??a/client.js')).toBe(true)
    expect(shouldNoStore('/assets/index-abc.js')).toBe(false)
  })
})

describe('dsh 子进程环境整表', () => {
  test('必需键缺一即抛（DSH_CLIENT_VERSION 缺失会让 0.2.1-alpha.2 启动致命）', () => {
    const env = buildChildEnv({
      base: { PATH: '/usr/bin', DSH_PROFILE_DIR: '/stale' },
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home',
    })
    expect(env.DSH_CLIENT_VERSION).toBe('0.12.0')
    expect(env.DSH_PROFILE).toBe('desktop')
    expect(env.DSH_HOME).toBe('/tmp/home')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.DSH_PROFILE_DIR).toBeUndefined()
    expect(() => assertChildEnv(env)).not.toThrow()
    expect(missingEnvKeys({ DSH_PROFILE: 'desktop', DSH_HOME: '/tmp/home' })).toEqual(['DSH_CLIENT_VERSION'])
  })

  test('显式传 profileDir/preloadTrees 时写进去；缺客户端版本时断言失败', () => {
    const env = buildChildEnv({
      base: {},
      clientVersion: '',
      profile: 'web',
      home: '/tmp/home',
      profileDir: '/tmp/home/profiles/web',
      preloadTrees: '/tmp/rt',
    })
    expect(env.DSH_PROFILE_DIR).toBe('/tmp/home/profiles/web')
    expect(env.DSH_BUN_PRELOAD_TREES).toBe('/tmp/rt')
    expect(() => assertChildEnv(env)).toThrow()
  })

  test('手机访问三件套：上游端口 + lane 端口 + 开关（旧壳 lifecycle.rs:394；缺上游端口插件会照 3080 去代理）', () => {
    const withMobile = buildChildEnv({
      base: {},
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home',
      upstreamPort: 3081,
      lanePort: 3092,
    })
    expect(withMobile.DSH_DESKTOP_PORT).toBe('3081')
    expect(withMobile.DSH_MOBILE_LANE_PORT).toBe('3092')
    expect(withMobile.DSH_MOBILE_ENABLED).toBe('1')

    // 不给就删干净（不能让上一次残留的 env 把插件指到别人的端口上）
    const without = buildChildEnv({
      base: { DSH_DESKTOP_PORT: '3080', DSH_MOBILE_LANE_PORT: '3091', DSH_MOBILE_ENABLED: '1' },
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home',
    })
    expect(without.DSH_DESKTOP_PORT).toBeUndefined()
    expect(without.DSH_MOBILE_LANE_PORT).toBeUndefined()
    expect(without.DSH_MOBILE_ENABLED).toBeUndefined()

    // 坏端口不下发
    const bad = buildChildEnv({
      base: {},
      clientVersion: '0.12.0',
      profile: 'desktop',
      home: '/tmp/home',
      upstreamPort: 0,
      lanePort: 70_000,
    })
    expect(bad.DSH_DESKTOP_PORT).toBeUndefined()
    expect(bad.DSH_MOBILE_LANE_PORT).toBeUndefined()
    expect(bad.DSH_MOBILE_ENABLED).toBeUndefined()
  })

  test('cloudflared 透传（旧壳 lifecycle.rs:414-417）：设置里有路径才注入，空白串当没设置', () => {
    const withBin = buildChildEnv({ base: {}, clientVersion: '0.12.0', profile: 'desktop', home: '/tmp/h', cloudflaredBin: ' /opt/homebrew/bin/cloudflared ' })
    expect(withBin.DSH_CLOUDFLARED_BIN).toBe('/opt/homebrew/bin/cloudflared')
    const withoutBin = buildChildEnv({ base: { DSH_CLOUDFLARED_BIN: '/old' }, clientVersion: '0.12.0', profile: 'desktop', home: '/tmp/h' })
    expect(withoutBin.DSH_CLOUDFLARED_BIN).toBeUndefined()
  })

  test('资源条件显式写在代码里（cwd / 隔离区清理 / fd 上限）', () => {
    expect(CHILD_RESOURCE_CONDITIONS.cwdIsHome).toBe(true)
    expect(CHILD_RESOURCE_CONDITIONS.quarantineCleanupBeforeSpawn).toBe(true)
    expect(CHILD_RESOURCE_CONDITIONS.rlimitNofile).toBe(16384)
  })
})
