// 静态资产解析：**静态优先**（规格第 2 条）——dist 命中就出磁盘文件，其余一律转发给 Host。
//
// 为什么不是前缀白名单（原规格写法，已作废）：插件自带路由 /smooth-stream/*、
// /dsh-mnemon-settings/*、/dsh-ui-progress/* 与带令牌前缀的 /<token>/plugins/??…
// 会被白名单漏掉（#219 实测 404）。对齐官方 protocol.handle：先查文件，查不到再转发。
//
// 安全不变量：只允许 dist 根之下的普通文件；拒绝穿越、NUL、反斜杠、绝对路径。

import { resolve, sep } from 'node:path'

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/** rel 是 URL 路径（以 / 开头）；返回 dist 内的绝对路径，非法或越界返回 null。 */
export function resolveAsset(distRoot: string, rel: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  if (!decoded.startsWith('/')) return null
  const trimmed = decoded.replace(/^\/+/, '')
  if (trimmed === '') return null
  const root = resolve(distRoot)
  const target = resolve(root, trimmed)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

/** 源映射沿用现状协议不变量：`.map` 一律 204（不外泄源码映射）。 */
export function isNoContentAsset(rel: string): boolean {
  const clean = rel.split('?')[0] ?? rel
  return clean.toLowerCase().endsWith('.map')
}

export const INDEX_FILE = 'index.html'
