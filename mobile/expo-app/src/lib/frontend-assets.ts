// 前端 dist 的获取与缓存（#155，与桌面远程模式的「下载对应运行时」同形）。
//
// 桌面那条路是：比对远程入口产物名 → 本地没有就**下载最新运行时** → 重比 → 命中即用。
// 手机只需要其中的**前端产物**（`@deepseek-ai/dsh-web-frontend` 的 `dist/`，几 MB，
// 而不是整个带 Node 的运行时），所以这里做同一件事的小号版本：
//   查 npm dist-tags → 下 .tgz → 解 gzip → 读 tar → 只取 `package/dist/**` → 产出
//   `{ version, entry, files }`，交给 local-host 的 `distFiles` / `readDistFile` 端口。
//
// 只依赖纯 JS 的 fflate（RN 没有 node 的 zlib；fflate 在 RN 与 vitest 都能跑），
// 于是「版本选择 / 包地址 / tar 解析 / dist 摘取」四件事都能单测锁死。

import { gunzipSync } from 'fflate';
import { entryName, FRONTEND_PACKAGE, NPM_REGISTRY } from '../../../shell-web/local-assets.mjs';

export interface NpmTags {
  [tag: string]: string;
}

/**
 * 选要下载的版本：优先 `next`，其次 `latest`，再退到任意一个 tag。
 *
 * 为什么优先 `next`：桌面内置运行时跟的就是 `next` 渠道（0.2.0-rc.2 在 `next` 上），
 * 手机要跟桌面「同一个前端构建」才能命中版本闸门；`latest` 通常是更早的稳定线。
 */
export function pickVersion(tags: NpmTags | null | undefined): string | null {
  if (!tags || typeof tags !== 'object') return null;
  for (const name of ['next', 'latest', 'alpha']) {
    const v = tags[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const anyTag = Object.values(tags).find((v) => typeof v === 'string' && v.trim());
  return anyTag ? anyTag.trim() : null;
}

/** npm 上 scoped 包的 tarball 地址（`@scope/name` → `.../name/-/name-<ver>.tgz`）。 */
export function tarballUrl(version: string, registry = NPM_REGISTRY, pkg = FRONTEND_PACKAGE): string {
  const bare = pkg.includes('/') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
  return `${registry.replace(/\/+$/, '')}/${pkg}/-/${bare}-${version}.tgz`;
}

export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * 最小 tar 读取器（ustar 头 + 512 对齐）：只认常规文件，跳过目录/软链/pax 头。
 *
 * 为什么自己写：需要的只是"把 tar 里的文件取出来"，而 node 的 tar 在 RN 上不可用；
 * 逻辑就几十行，纯函数、能用合成 tar 逐条测（比引一个 tar 库更可控）。
 */
export function parseTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  while (at + 512 <= buf.length) {
    const header = buf.subarray(at, at + 512);
    // 全零块 = 归档结束。
    if (header.every((b) => b === 0)) break;
    const name = cstr(header.subarray(0, 100));
    const sizeField = cstr(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeField || '0', 8) || 0;
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = at + 512;
    // 目录（'5'）与 pax 扩展头（'x'/'g'）不用；前缀（155）在本仓的包里用不到，忽略。
    if (type === '0' || type === '\0' || type === '') {
      if (name) out.push({ name, bytes: buf.subarray(dataStart, dataStart + size) });
    }
    at = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

function cstr(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
}

export interface FrontendDist {
  version: string;
  /** 入口产物名（`index-<hash>.js`）——版本闸门比的就是它。 */
  entry: string;
  /** 相对路径 → 字节（如 `assets/index-5SrrfWpU.js`）。 */
  files: Map<string, Uint8Array>;
}

/**
 * 从 .tgz 里摘出前端 dist：只取 `package/dist/**`，路径去掉 `package/dist/` 前缀。
 *
 * 返回 null 的情形都**明确**：解压失败、没有 `dist/`、或者 dist 里找不到入口产物
 * （最后一种等于"这份包不是前端产物"，不该被当成能用的本地资产）。
 */
export function distFromTarball(tgz: Uint8Array, version: string): FrontendDist | null {
  let raw: Uint8Array;
  try {
    raw = gunzipSync(tgz);
  } catch {
    return null;
  }
  const prefix = 'package/dist/';
  const files = new Map<string, Uint8Array>();
  for (const e of parseTar(raw)) {
    if (!e.name.startsWith(prefix)) continue;
    const rel = e.name.slice(prefix.length);
    if (!rel || rel.endsWith('/')) continue;
    files.set(rel, e.bytes);
  }
  const indexHtml = files.get('index.html');
  if (!indexHtml) return null;
  const entry = entryName(new TextDecoder().decode(indexHtml));
  if (!entry) return null;
  return { version, entry, files };
}

export interface FetchBytes {
  (url: string): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;
}

export interface DownloadFrontendOptions {
  fetchBytes: FetchBytes;
  registry?: string;
  /** 指定版本（缺省按 pickVersion 选）；测试与"重比"路径都会用到。 */
  version?: string;
}

export type DownloadFrontendResult =
  | { ok: true; dist: FrontendDist }
  | { ok: false; reason: string };

/**
 * 下载并解出前端 dist。任何一步失败都带明确原因（版本查不到 / HTTP 非 200 / 包坏了 / 没有入口产物）。
 */
export async function downloadFrontendDist(opts: DownloadFrontendOptions): Promise<DownloadFrontendResult> {
  const registry = opts.registry ?? NPM_REGISTRY;
  let version = opts.version ?? null;
  if (!version) {
    try {
      const res = await opts.fetchBytes(`${registry.replace(/\/+$/, '')}/${FRONTEND_PACKAGE}`);
      if (res.status !== 200) return { ok: false, reason: `查 npm 元数据失败：HTTP ${res.status}` };
      const meta = JSON.parse(await res.text()) as { 'dist-tags'?: NpmTags };
      version = pickVersion(meta['dist-tags']);
    } catch (e) {
      return { ok: false, reason: `查 npm 元数据出错：${String(e)}` };
    }
    if (!version) return { ok: false, reason: 'npm 元数据里没有可用版本' };
  }
  const url = tarballUrl(version, registry);
  try {
    const res = await opts.fetchBytes(url);
    if (res.status !== 200) return { ok: false, reason: `下载 ${url} 失败：HTTP ${res.status}` };
    const tgz = new Uint8Array(await res.arrayBuffer());
    const dist = distFromTarball(tgz, version);
    if (!dist) return { ok: false, reason: `包 ${version} 解不出前端 dist（缺 dist/index.html 或入口产物）` };
    return { ok: true, dist };
  } catch (e) {
    return { ok: false, reason: `下载/解包出错：${String(e)}` };
  }
}
