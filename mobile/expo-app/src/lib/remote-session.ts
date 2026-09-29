// 手机壳「远程会话」编排（#155）：把已有零件串成桌面远程模式那条链。
//
// 桌面的链是：换会话 cookie → 取远程首页 → 比构建标识 →（缺就下载运行时 → 重比）→
// 命中则本地出页面（远程 HTML + 本地资产 + 远程数据），否则回退「直接开远程页面」。
// 手机这里同形，只是资产换成 npm 上的前端 dist、页面 origin 换成 App 内 loopback 服务。
//
// 编排逻辑不直接碰网络/socket：每一步都是注入的端口，于是状态机能被逐条测死（见同目录测试）——
// 这条链最容易出错的地方恰恰是"哪一步失败该走哪条路"，而不是每一步本身。

import { buildGate, entryName, type GateResult, type LocalDist } from '../../../shell-web/local-assets.mjs';
import type { FrontendDist } from './frontend-assets';
import type { DownloadFrontendResult } from './frontend-assets';
import type { LocalHostRuntime, LocalHostRuntimeOptions } from './local-host-runtime';
import type { SessionExchangeResult } from './session';

export interface RemoteSessionPorts {
  /** 远端 authority（`host:port`）。 */
  base: string;
  /** 一次性入口路径（`/pair?token=…`）；没有就只做版本检测。 */
  entryPath?: string | null;
  /** 壳持有的会话 cookie（调用方从缓存取；没有就等 exchange）。 */
  cookie?: string | null;
  /** 端口：用入口地址换取会话 cookie。 */
  exchange?: (base: string, entryPath: string) => Promise<SessionExchangeResult>;
  /** 端口：取远端首页 HTML（已带会话）。 */
  fetchRemoteHtml: () => Promise<{ ok: true; html: string } | { ok: false; reason: string }>;
  /** 已缓存可用的本地 dist 清单（可能多于一份：历史下载的版本）。 */
  localDists: LocalDist[];
  /** 端口：下载前端 dist（真实实现走 npm；测试注入假货）。 */
  download: () => Promise<DownloadFrontendResult>;
  /** 端口：起壳内服务。 */
  startHost: (opts: LocalHostRuntimeOptions) => Promise<LocalHostRuntime>;
  /** 端口：读本地 dist 文件。 */
  readDistFile: (rel: string) => Promise<Uint8Array | null>;
  /** 随包布局插件（Host 没装时唯一来源）；null = 不随包。 */
  bundledPluginSource?: string | null;
  /** 随包插件 rev（写进启动图当缓存失效用）。 */
  pluginRev?: string;
  onLog?: (line: string) => void;
}

/** 用户在闸门三选一里选的那条路（与桌面三选一同构）。 */
export type GateChoice = 'download' | 'useLocal' | 'remoteWebview';

export type RemoteSessionOutcome =
  /** 已就绪：WebView 该加载 `url`（壳内 origin）。 */
  | { kind: 'settled'; url: string; cookie: string | null; version: string; entry: string }
  /** 需要用户三选一（本地没有匹配产物）。 */
  | { kind: 'gate-required'; gate: Extract<GateResult, { kind: 'missing' } | { kind: 'unavailable' }> }
  /** 回退：直接以 URL 打开远端页面（最保守、永远可用）。 */
  | { kind: 'fallback'; url: string; reason: string };

/** 把本地 dist 折成闸门要的形状。 */
function asLocalDists(dist: FrontendDist | null, extra: LocalDist[]): LocalDist[] {
  const list = [...extra];
  if (dist && !list.some((d) => d.id === dist.version)) list.push({ id: dist.version, entry: dist.entry });
  return list;
}

/**
 * 起一次远程会话（第一阶段：换会话 + 版本检测）。
 *
 * 不在这里问用户：检测到「本地没有匹配产物」就返回 `gate-required`，由 UI 去问（桌面也是弹窗问）。
 * 这样状态机保持纯函数式，测试不需要模拟对话框。
 */
export async function openRemoteSession(ports: RemoteSessionPorts): Promise<RemoteSessionOutcome> {
  const log = ports.onLog ?? (() => {});
  let cookie = ports.cookie ?? null;

  // ① 一次性入口（有 token 的地址）：换取会话 cookie。失败不中止——照常去比版本，
  //    真需要鉴权时页面自己会提示（桌面同样是"换取失败照常导航"）。
  if (ports.entryPath && ports.exchange) {
    const res = await ports.exchange(ports.base, ports.entryPath);
    if (res.ok) {
      cookie = res.cookie;
      log(`[session] 已换取会话 cookie（${res.cookie.split('=')[0]}）`);
    } else {
      log(`[session] 换取会话失败：${res.reason}`);
    }
  }

  // ② 取远端首页：拿不到就没法比版本 —— 这是 `unavailable`，不是"缺产物"。
  const html = await ports.fetchRemoteHtml();
  const remoteEntry = html.ok ? entryName(html.html) : null;

  // ③ 版本闸门。
  const gate = buildGate({ remoteEntry, localDists: asLocalDists(null, ports.localDists) });
  if (gate.kind === 'matched') {
    return settle(ports, gate.dist, html.ok ? html.html : '', cookie, log);
  }
  if (gate.kind === 'missing' || gate.kind === 'unavailable') {
    return { kind: 'gate-required', gate };
  }
  // buildGate 只有上面三种形态；兜底成回退，避免"静默什么都不做"。
  return { kind: 'fallback', url: `http://${ports.base}/`, reason: '版本闸门未给出可用结论' };
}

/**
 * 第二阶段：用户在闸门里选完之后继续。
 *
 * - `download`：下载 → **重比**（命中就settled；仍不匹配则**再问一次**，对齐桌面 `ask_after_download`）；
 * - `useLocal`：用现有默认产物（版本可能不一致，调用方负责提示）；
 * - `remoteWebview`：回退直接开远端页面。
 */
export async function continueRemoteSession(
  ports: RemoteSessionPorts,
  choice: GateChoice,
  fallbackDist?: FrontendDist | null,
): Promise<RemoteSessionOutcome> {
  const log = ports.onLog ?? (() => {});
  if (choice === 'remoteWebview') {
    return { kind: 'fallback', url: `http://${ports.base}/`, reason: '用户选择直接打开远程页面' };
  }

  if (choice === 'download') {
    const dl = await ports.download();
    if (!dl.ok) {
      log(`[assets] 下载失败：${dl.reason}`);
      return { kind: 'fallback', url: `http://${ports.base}/`, reason: `下载运行时失败：${dl.reason}` };
    }
    const html = await ports.fetchRemoteHtml();
    const remoteEntry = html.ok ? entryName(html.html) : null;
    const gate = buildGate({
      remoteEntry,
      localDists: asLocalDists(dl.dist, ports.localDists),
    });
    if (gate.kind === 'matched') return settle(ports, gate.dist, html.ok ? html.html : '', ports.cookie ?? null, log);
    // 下载完还是不匹配：把新的现状交回 UI 再问一次（桌面同款行为）。
    return { kind: 'gate-required', gate };
  }

  // useLocal：用调用方给的那份（没有就退到已缓存的任意一份；再没有就回退）。
  const dist = fallbackDist ?? null;
  if (!dist) {
    const first = ports.localDists[0];
    if (!first) {
      return { kind: 'fallback', url: `http://${ports.base}/`, reason: '本地没有任何可用产物' };
    }
    const html = await ports.fetchRemoteHtml();
    return settle(ports, first, html.ok ? html.html : '', ports.cookie ?? null, log);
  }
  const html = await ports.fetchRemoteHtml();
  return settle(ports, { id: dist.version, entry: dist.entry }, html.ok ? html.html : '', ports.cookie ?? null, log);
}

/** 起壳内服务并给出页面地址（三个 settled 分支共用）。 */
async function settle(
  ports: RemoteSessionPorts,
  dist: LocalDist,
  _remoteHtml: string,
  cookie: string | null,
  log: (line: string) => void,
): Promise<RemoteSessionOutcome> {
  const host = await ports.startHost({
    remoteBase: ports.base,
    remoteAuthority: ports.base,
    // dist 文件清单由「当前生效那份」决定：调用方给的是**已缓存**的清单，
    // 这里用 id 反查（下载路径与缓存路径都会把清单挂在 localDists 上）。
    distFiles: distEntryFiles(ports, dist),
    readDistFile: ports.readDistFile,
    bundledPlugins: ports.bundledPluginSource ? { 'dsh-web-mobile': ports.bundledPluginSource } : {},
    pluginRev: ports.pluginRev,
    fetchUpstream: async () => ({ status: 502, headers: {}, body: 'fetchUpstream 端口未注入' }),
    onLog: log,
  });
  log(`[host] 壳内服务已起：${host.url}（产物 ${dist.id} / ${dist.entry}）`);
  return { kind: 'settled', url: host.url, cookie, version: dist.id, entry: dist.entry };
}

/**
 * 当前生效产物对应的文件清单。
 *
 * 约定：`localDists` 里每项的 `files` 字段（可选）就是清单 —— 让「清单」与「版本标识」同行，
 * 避免调用方再维护一张按版本的映射表（少一处会漂移的状态）。
 */
function distEntryFiles(ports: RemoteSessionPorts, dist: LocalDist): string[] {
  const hit = ports.localDists.find((d) => d.id === dist.id) as (LocalDist & { files?: string[] }) | undefined;
  return hit?.files ?? [];
}
