// 远程会话端口的**真实实现**（#155）：把编排用到的每一步接到真实 fetch / 存储 / 缓存上。
//
// 编排（remote-session.ts）只认端口，本文件负责把端口接到现实：
//   换会话 → session.ts（壳持有 cookie）
//   取首页/转发 → session.ts 的 createUpstreamPort（注入 cookie、剥 set-cookie）
//   下载前端 dist → frontend-assets.ts（npm → .tgz → dist）
//   起壳内服务 → local-host-runtime.ts（react-native-tcp-socket，**惰性**加载）
//   cookie 与 dist 缓存 → 注入的存储端口（App 里是 AsyncStorage；测试里是内存）

import { createUpstreamPort, exchangeForSession, type FetchLike } from './session';
import { downloadFrontendDist, type FetchBytes, type FrontendDist } from './frontend-assets';

import type { DistCache } from './dist-cache';
// 类型导入：`local-host-runtime` 会引原生模块 react-native-tcp-socket，node（vitest）里加载不了，
// 所以真实的 startLocalHost 走下面的惰性动态 import；本模块必须能在无原生环境下被导入与测试。
import type { LocalHostRuntime, LocalHostRuntimeOptions } from './local-host-runtime';
import type { RemoteSessionPorts } from './remote-session';
import { entryName, type LocalDist } from '../../../shell-web/local-assets.mjs';

/** 键值存储端口（App 用 AsyncStorage，测试用内存）。 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** 会话 cookie 的存储键：按远端 authority 分开（一台手机可能配多个桌面）。 */
export function cookieKey(base: string): string {
  return `dsh-mobile-session:${base}`;
}

/** 记住「上次用过的前端产物版本」的键：冷启动靠它找到该读哪份磁盘缓存。 */
export function distVersionKey(base: string): string {
  return `dsh-mobile-dist:${base}`;
}

export interface RemotePortsOptions {
  /** 远端 authority（`host:port`）。 */
  base: string;
  /** 一次性入口路径（`/pair?token=…`）；没有就只做版本检测。 */
  entryPath?: string | null;
  /** 网络端口（默认全局 fetch）。 */
  fetchImpl?: FetchLike & FetchBytes;
  store: KeyValueStore;
  cachedDist?: FrontendDist | null;
  /** 收下新下载的 dist（调用方负责持久化）。 */
  onDistDownloaded?: (dist: FrontendDist) => void;
  /** 随包布局插件内容（Host 没装时唯一来源）。 */
  bundledPluginSource?: string | null;
  pluginRev?: string;
  onLog?: (line: string) => void;
  /** 起服务端口（默认真实实现；测试可注入假货）。 */
  startHost?: (opts: LocalHostRuntimeOptions) => Promise<LocalHostRuntime>;
  /** 持久化缓存（有它时：冷启动先读缓存，下载成功后落盘）。 */
  cache?: DistCache;
}

/**
 * 组装编排需要的全部端口。
 *
 * 两个关键点：
 * 1. `localDists` 是**活视图**（同一个数组实例，随 dist 变化就地更新）。编排在「下载 → 重比 →
 *    起服务」那条路上会回头按 id 查「这份产物有哪些文件」；快照式赋值会让那条路拿到空清单，
 *    本地资产静默全转发（这是测试推出来的 bug）。
 * 2. 文件清单与版本同行（同一次解包的结果），调用方不必再维护一张按版本的映射表。
 */
export async function createRemotePorts(opts: RemotePortsOptions): Promise<RemoteSessionPorts> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike & FetchBytes);
  const cachedCookie = await opts.store.getItem(cookieKey(opts.base));
  let dist = opts.cachedDist ?? null;
  // ① **随包内置运行时优先**（与鸿蒙 rawfile 按需直读、桌面内置运行时同形）：配好对就能进，
  //    既不先联网、也不先下几 MB；命中即当「本地产物」，版本闸门拿它的入口产物名去比。
  let pluginSource = opts.bundledPluginSource ?? null;
  if (!dist) {
    // 惰性 + 容错：`builtin-assets` 引原生模块（expo-asset / expo-file-system），
    // node（vitest）里加载不了；测试与无随包环境都应当安静地退回下载路径。
    let builtin: Awaited<ReturnType<typeof import('./builtin-assets').loadBuiltinAssets>> = null;
    try {
      const mod = await import('./builtin-assets');
      builtin = await mod.loadBuiltinAssets();
    } catch {
      builtin = null;
    }
    if (builtin !== null) {
      dist = builtin.dist;
      if (pluginSource === null) pluginSource = builtin.pluginClientJs;
      opts.onLog?.(`[assets] 命中随包内置运行时：${builtin.dist.entry}`);
    }
  }
  // 冷启动优先复用**磁盘缓存**（版本号记在同一个存储里）：省掉重下几 MB，也少等一轮网络。
  // 读不出来（首次启动 / 缓存残缺）就当没有 → 走下面的检测与下载。
  if (!dist && opts.cache) {
    const lastVersion = await opts.store.getItem(distVersionKey(opts.base));
    if (lastVersion) {
      dist = await opts.cache.load(lastVersion);
      if (dist) opts.onLog?.(`[assets] 命中本地缓存 ${dist.version}（入口 ${dist.entry}）`);
    }
  }

  const localDists: Array<LocalDist & { files?: string[] }> = [];
  const syncLocalDists = () => {
    localDists.length = 0;
    if (dist) localDists.push({ id: dist.version, entry: dist.entry, files: [...dist.files.keys()] });
  };
  syncLocalDists();

  const upstream = createUpstreamPort({ base: opts.base, cookie: cachedCookie, fetchImpl });

  return {
    base: opts.base,
    entryPath: opts.entryPath ?? null,
    cookie: cachedCookie,
    exchange: async (base: string, entryPath: string) => {
      const res = await exchangeForSession({ base, entryPath, fetchImpl });
      if (res.ok) await opts.store.setItem(cookieKey(base), res.cookie);
      return res;
    },
    fetchRemoteHtml: async () => {
      const res = await upstream({ method: 'GET', path: '/', headers: { accept: 'text/html' } });
      const html = typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body);
      if (res.status < 200 || res.status >= 300) {
        return { ok: false as const, reason: `远端首页 HTTP ${res.status}` };
      }
      // 能取到页面但认不出入口产物（老版 dsh）：由编排那边判 unavailable，这里只回 HTML。
      return { ok: true as const, html: html || '' };
    },
    localDists,
    download: async () => {
      const out = await downloadFrontendDist({ fetchBytes: fetchImpl });
      if (out.ok) {
        dist = out.dist;
        syncLocalDists();
        // 落盘 + 记住版本：下次冷启动直接命中（缓存不完整时 dist-cache 会拒绝，见那边注释）。
        if (opts.cache) {
          await opts.cache.save(out.dist);
          await opts.store.setItem(distVersionKey(opts.base), out.dist.version);
        }
        opts.onDistDownloaded?.(out.dist);
        opts.onLog?.(`[assets] 已下载前端产物 ${out.dist.version}（入口 ${out.dist.entry}）`);
      }
      return out;
    },
    readDistFile: async (rel: string) => dist?.files.get(rel) ?? null,
    bundledPluginSource: pluginSource,
    pluginRev: opts.pluginRev,
    onLog: opts.onLog,
    // 默认真实实现：按需加载原生 socket 模块（见文件头注释）。
    startHost:
      opts.startHost ??
      (async (o: LocalHostRuntimeOptions) => {
        const mod = await import('./local-host-runtime');
        return mod.startLocalHost(o);
      }),
  };
}

/** 供 UI 用：从页面 HTML 里认出远端构建标识（null = 老版/取不到 → 编排判 unavailable）。 */
export function remoteEntryOf(html: string): string | null {
  return entryName(html);
}
