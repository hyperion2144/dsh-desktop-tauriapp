import { describe, expect, test } from 'bun:test'
import { normalizeRemoteUrl, remoteDisplay, remoteHostPort, remoteOrigin } from '../src/shared/remote.ts'

describe('normalizeRemoteUrl（旧壳 normalize_remote_url）', () => {
  test('补 http:// scheme', () => {
    expect(normalizeRemoteUrl('192.168.1.9:3091')).toBe('http://192.168.1.9:3091/')
  })
  test('完整 URL 原样规范化', () => {
    expect(normalizeRemoteUrl('  https://host.example:8443/  ')).toBe('https://host.example:8443/')
  })
  test('带 token 的完整启动 URL 保留 query', () => {
    expect(normalizeRemoteUrl('http://10.0.0.2:3080/?token=abc')).toBe('http://10.0.0.2:3080/?token=abc')
  })
  test('拒绝非 http(s)', () => {
    expect(normalizeRemoteUrl('ftp://x/')).toBeNull()
  })
  test('拒绝带路径', () => {
    expect(normalizeRemoteUrl('http://x/y')).toBeNull()
  })
  test('拒绝 userinfo', () => {
    expect(normalizeRemoteUrl('http://a:b@x/')).toBeNull()
  })
  test('空串与空白', () => {
    expect(normalizeRemoteUrl('')).toBeNull()
    expect(normalizeRemoteUrl('   ')).toBeNull()
  })
})

describe('remoteDisplay / remoteHostPort / remoteOrigin', () => {
  test('display 取 host:port 不带 token', () => {
    expect(remoteDisplay('http://10.0.0.2:3080/?token=abc')).toBe('10.0.0.2:3080')
  })
  test('display 无端口时只有 host', () => {
    expect(remoteDisplay('https://dsh.example.com/')).toBe('dsh.example.com')
  })
  test('旧格式原样返回', () => {
    expect(remoteDisplay('x.cn:3091')).toBe('x.cn:3091')
  })
  test('hostPort 补 scheme 缺省端口', () => {
    expect(remoteHostPort('https://dsh.example.com/?token=x')).toBe('dsh.example.com:443')
    expect(remoteHostPort('http://10.0.0.2:3080/')).toBe('10.0.0.2:3080')
  })
  test('origin 供数据面反代', () => {
    expect(remoteOrigin('http://10.0.0.2:3080/?token=abc')).toBe('http://10.0.0.2:3080')
  })
})
