/** 远程 dsh 地址（旧壳 `network/remote.rs` 的纯逻辑等价物）。 */

/** 归一化远程地址：补 scheme、只认 http(s)、路径必须是根、拒绝 userinfo（旧壳 normalize_remote_url）。 */
export function normalizeRemoteUrl(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null
  const withScheme = raw.includes('://') ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.username !== '' || url.password !== '') return null
  return url.toString()
}

/** 展示名：URL 形态取 host[:port]（不带 token），旧格式原样（旧壳 remote_display）。 */
export function remoteDisplay(addr: string): string {
  try {
    const url = new URL(addr)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return addr
    const host = url.hostname
    return url.port !== '' ? `${host}:${url.port}` : host
  } catch {
    return addr
  }
}

/** TCP 连接目标 host:port（scheme 缺省端口 80/443；旧壳 remote_host_port）。 */
export function remoteHostPort(addr: string): string {
  try {
    const url = new URL(addr)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return addr
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    return `${url.hostname}:${String(port)}`
  } catch {
    return addr
  }
}

/** 数据面上游 origin（scheme://host[:port]）。 */
export function remoteOrigin(addr: string): string {
  return new URL(addr).origin
}
