/**
 * 鸿蒙壳的「本地资产」装配（#155）：会话由壳持有 + 拉取前端产物到沙箱 + 版本闸门。
 *
 * 三件事，与桌面远程模式/Expo 侧逐条同形（依据 #150 研究 / #151 #152 #153 决策）：
 *   ① **会话由壳持有**：配对链接是一次性凭据，**绝不能让 ArkWeb 直接加载去消费**（那样壳自己
 *      换不到 cookie，也无法在转发时注入）。这里由壳发起 `/pair?token=` 请求、从 3xx 的
 *      `set-cookie` 里取设备会话，存进 preferences（按 authority 分键）；
 *   ② **拉取前端产物**：取远端首页 → 认出入口产物名（构建标识）+ 被引用的 `assets/*` →
 *      从远端 `assets/*` 下载到沙箱（只下静态资产，不拉整个运行时——手机不需要 Node 那部分）；
 *   ③ **版本闸门**：本地已缓存的入口产物名与远端当前入口名一致就直接用缓存（冷启动零下载），
 *      不一致则重新下载（等价于桌面的「下载对应运行时 → 重比」）。
 *
 * ArkTS 约束（编译器实测）：不许索引签名（`Record<string,string>` 用不了，动态头用 Map，
 * 少量固定字段用已声明接口 + 带引号的属性名）、`catch` 参数要显式转 `BusinessError`。
 */
import http from '@ohos.net.http';
import fs from '@ohos.file.fs';
import preferences from '@ohos.data.preferences';
import util from '@ohos.util';
import { BusinessError } from '@kit.BasicServicesKit';
import { entryNameOf } from './LocalHost';

/** 本地已就绪的前端产物（注意：接口名不能叫 `LocalAssets`，会与本模块名撞车）。 */
export interface LocalAssetBundle {
  /** 本地 dist 的沙箱目录。 */
  dir: string;
  /** 远端当前入口产物名（构建标识）。 */
  entry: string;
  /** dist 的文件相对路径清单（含 `index.html`）。 */
  files: string[];
}

export interface SessionExchange {
  ok: boolean;
  cookie: string;
  reason: string;
}

/** 取远端时的请求头（只这两样）。 */
interface RemoteRequestHeaders {
  accept?: string;
  cookie?: string;
}

/** 壳自有状态的 preferences 库名（会话 cookie 与产物版本都存这里）。 */
const PREF_STORE = 'dsh_mobile_shell';

/** 会话 cookie 的键（按 authority 分开：一台手机可能配多个桌面）。 */
export function cookieKey(base: string): string {
  return `session:${base}`;
}

/** 前端产物缓存的键（记住上次用的入口产物名）。 */
export function entryKey(base: string): string {
  return `dist-entry:${base}`;
}

/** 一次性入口路径判定：只认冻结别名 `/pair`、`/__dsh-mobile/pair` 与带 token 的地址。 */
export function entryPathOf(url: string): string {
  const at = url.indexOf('://');
  const rest = at >= 0 ? url.substring(at + 3) : url;
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  const pathQuery = rest.substring(slash);
  const q = pathQuery.indexOf('?');
  const path = (q >= 0 ? pathQuery.substring(0, q) : pathQuery).replace(/\/+$/, '');
  const hasToken = pathQuery.indexOf('token=') >= 0;
  if (path === '/pair' || path === '/__dsh-mobile/pair' || hasToken) return pathQuery;
  return '';
}

/** 读壳持有的会话 cookie（没有返回空串）。 */
export async function loadCookie(context: Context, base: string): Promise<string> {
  const store = await preferences.getPreferences(context, PREF_STORE);
  return (await store.get(cookieKey(base), '')) as string;
}

async function saveString(context: Context, key: string, value: string): Promise<void> {
  const store = await preferences.getPreferences(context, PREF_STORE);
  await store.put(key, value);
  await store.flush();
}

/**
 * 用一次性入口换取设备会话 cookie 并**由壳存下**（#151）。
 *
 * 判据是**有没有 `set-cookie`**，不是状态码（lane 回 302、dsh 的 `/?token=` 回 303 都正常）；
 * 失败把状态码与入口带进 reason，不让人猜（与桌面 `shell_origin`、Expo `session.ts` 同款判断）。
 */
export async function exchangeSession(
  context: Context,
  base: string,
  entryPath: string,
): Promise<SessionExchange> {
  const client = http.createHttp();
  try {
    const headers: RemoteRequestHeaders = { accept: 'application/json' };
    const res = await client.request(`http://${base}${entryPath}`, {
      method: http.RequestMethod.GET,
      header: headers,
      expectDataType: http.HttpDataType.STRING,
    });
    // `res.cookies` 是 SDK 给出的响应 cookie 字段（ArkTS 禁止按索引读响应头，`res.header['set-cookie']` 不过编译）。
    const setCookieRaw = res.cookies;
    let setCookie = '';
    if (typeof setCookieRaw === 'string' && setCookieRaw !== '') {
      setCookie = setCookieRaw;
    }
    if (setCookie === '') {
      return { ok: false, cookie: '', reason: `HTTP ${res.responseCode} 且无 set-cookie（入口 ${entryPath}）` };
    }
    // set-cookie 有两种形态，**两种都要认**：
    //   ① 标准头：`dsh_mobile_session=abc; Path=/; HttpOnly`
    //   ② **Netscape 表行**——`@ohos.net.http` 的 `res.cookies` 实际返回的就是这个：
    //      `#HttpOnly_192.168.3.90\tFALSE\t/\tFALSE\t0\tdsh_mobile_session\tabc`
    // 只认 ① 会把**有效的设备会话**当“形状不符”丢掉 → 后续首页 401 → 本地资产永远失败、
    // 三选一必弹（实机 hilog 定位：`set-cookie 形状不符：#HttpOnly_192.168.3.90  FALSE ...`）。
    let cookie = '';
    const cols = setCookie.split('\t');
    if (cols.length >= 2) {
      const value = cols[cols.length - 1].trim();
      const name = cols[cols.length - 2].trim();
      if (name !== '' && value !== '') cookie = `${name}=${value}`;
    } else {
      const head = (setCookie.split(';')[0] ?? '').trim();
      if (head.indexOf('=') > 0) cookie = head;
    }
    if (cookie === '') {
      return { ok: false, cookie: '', reason: `set-cookie 形状不认识：${setCookie}` };
    }
    await saveString(context, cookieKey(base), cookie);
    return { ok: true, cookie: cookie, reason: '' };
  } catch (err) {
    const e = err as BusinessError;
    return { ok: false, cookie: '', reason: `换会话失败：${e.message}` };
  } finally {
    client.destroy();
  }
}

/** 取远端首页（带壳持有的会话）。 */
export async function fetchRemoteHtml(base: string, cookie: string): Promise<string> {
  const client = http.createHttp();
  try {
    const header: RemoteRequestHeaders = { accept: 'text/html' };
    if (cookie !== '') header.cookie = cookie;
    const res = await client.request(`http://${base}/`, {
      method: http.RequestMethod.GET,
      header: header,
      expectDataType: http.HttpDataType.STRING,
    });
    const code = res.responseCode as number;
    if (code < 200 || code >= 300) {
      throw new Error(`远端首页 HTTP ${code}`);
    }
    return res.result as string;
  } finally {
    client.destroy();
  }
}

/** 页面里被引用的静态资产（`./assets/...`）：script/src 与 link/href 都算。 */
export function assetPathsOf(html: string): string[] {
  const out: string[] = [];
  const re = /(?:src|href)\s*=\s*["']\.?\/?(assets\/[^"']+)["']/g;
  let m = re.exec(html);
  while (m !== null) {
    const rel = m[1].split('?')[0];
    if (out.indexOf(rel) < 0) out.push(rel);
    m = re.exec(html);
  }
  return out;
}

function writeFile(dir: string, rel: string, bytes: ArrayBuffer): void {
  const full = `${dir}/${rel}`;
  const slash = full.lastIndexOf('/');
  if (slash > 0) {
    const parent = full.substring(0, slash);
    if (!fs.accessSync(parent)) fs.mkdirSync(parent, true);
  }
  const file = fs.openSync(full, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
  fs.writeSync(file.fd, bytes);
  fs.closeSync(file);
}

/** 缓存目录：`<filesDir>/dsh-frontend/<entry>`（按入口产物名分目录 = 按构建分目录）。 */
export function distDirFor(context: Context, entry: string): string {
  return `${context.filesDir}/dsh-frontend/${entry}`;
}

/**
 * 确保本地有与远端**同一构建**的前端产物：
 * 命中缓存（入口名一致 + `index.html` 在）→ 直接返回；否则从远端 `assets/*` 拉齐并落盘。
 *
 * 为什么按「被引用的 assets 清单」而不是整包下载：手机只需要前端静态产物（几 MB），
 * 而 Host 本来就在 `/assets/*` 上提供这些文件（同一个构建）；tar/gzip 解包在 ArkTS 侧还要额外依赖。
 */
export async function ensureLocalAssets(
  context: Context,
  base: string,
  cookie: string,
  onLog?: (line: string) => void,
): Promise<LocalAssetBundle> {
  const html = await fetchRemoteHtml(base, cookie);
  const entry = entryNameOf(html);
  if (entry === '') throw new Error('远端首页认不出入口产物（老版 dsh？）');

  // ① **先跟随包内置那份比**（与桌面「内置运行时命中就不下载」同一逻辑）：命中 = 远端与内置同
  //    一构建 → 直接用内置产物，零下载、**不弹三选一**。这一步曾经缺失，导致内置与远端都是
  //    0.2.0-rc.2 却仍然走下载并失败（用户实测到的现象）。
  const bundle0 = await bundledAssets(context);
  if (bundle0 !== null && bundle0.entry === entry) {
    onLog?.(`[assets] 命中随包内置产物：${entry}`);
    return bundle0;
  }

  const store = await preferences.getPreferences(context, PREF_STORE);
  const cachedEntry = (await store.get(entryKey(base), '')) as string;
  const dir = distDirFor(context, entry);
  if (cachedEntry === entry && fs.accessSync(`${dir}/index.html`)) {
    return { dir: dir, entry: entry, files: listFiles(dir) };
  }

  // ③ 都没有：**不自己从 Host 拓文件**（那不是桌面的形态）——把「远端是哪个构建、内置是哪个」
  //    说清楚，交回三选一（下载对应运行时 / 用当前本地 / 直接开远程页）。
  const builtin = bundledEntry(context);
  throw new Error(`远端构建 ${entry} 与内置 ${builtin === '' ? '（无）' : builtin} 不同：请选「下载对应运行时」或「直接加载远程页面」`);
}

async function downloadToBuffer(url: string, cookie: string): Promise<ArrayBuffer | null> {
  const client = http.createHttp();
  try {
    const header: RemoteRequestHeaders = {};
    if (cookie !== '') header.cookie = cookie;
    const res = await client.request(url, {
      method: http.RequestMethod.GET,
      header: header,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
    });
    if ((res.responseCode as number) !== 200) return null;
    return res.result as ArrayBuffer;
  } catch (err) {
    return null;
  } finally {
    client.destroy();
  }
}

/** 递归列出目录下的相对路径（供 LocalHost 的 distFiles 用）。 */
export function listFiles(dir: string, prefix: string = ''): string[] {
  const out: string[] = [];
  try {
    const names = fs.listFileSync(dir);
    for (const name of names) {
      const rel = prefix !== '' ? `${prefix}/${name}` : name;
      const full = `${dir}/${rel}`;
      if (fs.statSync(full).isDirectory()) {
        const inner = listFiles(full, rel);
        for (const p of inner) out.push(p);
      } else {
        out.push(rel);
      }
    }
  } catch (err) {
    // 目录不存在 = 空清单
  }
  return out;
}

/** 读随包布局插件的 client.js（放在 `resources/rawfile` 里随包分发；空 = 不随包）。 */
export function readBundledPlugin(context: Context, name: string = 'dsh-web-mobile/client.js'): string {
  try {
    const data = context.resourceManager.getRawFileContentSync(`plugins/${name}`);
    return new util.TextDecoder().decodeWithStream(data);
  } catch (err) {
    return '';
  }
}

/**
 * 读沙箱里已缓存的那份产物（三选一的「用当前本地运行时」）。
 *
 * 与 `ensureLocalAssets` 的区别：**不比对远端版本**、也不联网——用户明确选择「就用本地这份」时，
 * 版本可能不符（面板上已写明），但至少能进去；返回 null 表示本地一份都没有。
 */
export async function cachedAssets(context: Context, base: string): Promise<LocalAssetBundle | null> {
  const store = await preferences.getPreferences(context, PREF_STORE);
  const cachedEntry = (await store.get(entryKey(base), '')) as string;
  if (cachedEntry !== '') {
    const dir = distDirFor(context, cachedEntry);
    if (fs.accessSync(`${dir}/index.html`)) {
      return { dir: dir, entry: cachedEntry, files: listFiles(dir) };
    }
  }
  // 沙箱里没有（首次安装必然如此）：退回**随包内置**那份——这正是「用当前本地运行时」应有的默认，
  // 而不是告诉用户“没有已缓存的产物”（用户实测反馈的原话）。
  return await bundledAssets(context);
}

/** 随包内置产物的入口产物名（rawfile/dsh-frontend-manifest.json，由 scripts/sync-builtin.sh 生成）。 */
export function bundledEntry(context: Context): string {
  try {
    const raw = context.resourceManager.getRawFileContentSync('dsh-frontend-manifest.json');
    const text = new util.TextDecoder().decodeWithStream(raw);
    const m = /"entry"\s*:\s*"([^"]+)"/.exec(text);
    return m ? m[1] : '';
  } catch (err) {
    return ''; // 没随包（或 manifest 缺）→ 空串，上层走下载路径
  }
}

/** 把随包内置产物**铺到沙箱**（LocalHost 用 fs 读文件，得先落到可读目录）。 */
function seedFromBundle(context: Context, entry: string): string {
  const dir = distDirFor(context, entry);
  writeBundledDir(context, 'dsh-frontend', dir, '');
  return dir;
}

function writeBundledDir(context: Context, rawDir: string, diskDir: string, rel: string): void {
  // 资源枚举失败（实机报 `Invalid relative path. Please confirm: …`）不能把整条链打断：
  // 这一层只是「把随包产物铺到沙箱」，铺不了就让它交回空，由上层走三选一里的其它两条路。
  let names: string[] = [];
  try {
    names = context.resourceManager.getRawFileListSync(rel === '' ? rawDir : `${rawDir}/${rel}`);
  } catch (err) {
    return;
  }
  for (const name of names) {
    const childRel = rel === '' ? name : `${rel}/${name}`;
    const children = context.resourceManager.getRawFileListSync(`${rawDir}/${childRel}`);
    if (children.length > 0) {
      writeBundledDir(context, rawDir, diskDir, childRel);
      continue;
    }
    const bytes = context.resourceManager.getRawFileContentSync(`${rawDir}/${childRel}`);
    writeFile(diskDir, childRel, bytes.buffer as ArrayBuffer);
  }
}

/**
 * 随包内置产物的 bundle（#155）：铺到沙箱后当本地产物用。
 *
 * 与 `cachedAssets` 的区别：这份**一定存在**（除非构建时没跑 sync-builtin.sh），所以
 * 首次安装、离线、远端换了构建却没网时，它都是「用当前本地运行时」的兼底。
 */
export async function bundledAssets(context: Context): Promise<LocalAssetBundle | null> {
  const entry = bundledEntry(context);
  if (entry === '') return null;
  let dir = distDirFor(context, entry);
  try {
    dir = seedFromBundle(context, entry);
  } catch (err) {
    // 铺沙箱出错也不当致命：只要目录里已经有 index.html（上次铺过），照样能用随包产物。
    return fs.accessSync(`${dir}/index.html`) ? { dir: dir, entry: entry, files: listFiles(dir) } : null;
  }

  if (!fs.accessSync(`${dir}/index.html`)) return null;
  return { dir: dir, entry: entry, files: listFiles(dir) };
}

/** npm 的按文件 CDN（取的是包里的同一份字节；ArkTS 侧 decompressFile 只支持 zip，没走 tgz）。 */
const NPM_CDN = 'https://cdn.jsdelivr.net/npm';
const FRONTEND_PKG = '@deepseek-ai/dsh-web-frontend';
const NPM_REGISTRY = 'https://registry.npmjs.org';

async function httpText(url: string, cookie: string): Promise<string> {
  const client = http.createHttp();
  try {
    const header: RemoteRequestHeaders = {};
    if (cookie !== '') header.cookie = cookie;
    const res = await client.request(url, {
      method: http.RequestMethod.GET,
      header: header,
      expectDataType: http.HttpDataType.STRING,
    });
    if ((res.responseCode as number) !== 200) throw new Error(`HTTP ${res.responseCode}：${url}`);
    return res.result as string;
  } finally {
    client.destroy();
  }
}

async function httpBytes(url: string): Promise<ArrayBuffer> {
  const client = http.createHttp();
  try {
    const res = await client.request(url, {
      method: http.RequestMethod.GET,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
    });
    if ((res.responseCode as number) !== 200) throw new Error(`HTTP ${res.responseCode}：${url}`);
    return res.result as ArrayBuffer;
  } finally {
    client.destroy();
  }
}

/** 选要下载的版本：next > latest > alpha > 任意 tag（与 Expo 侧 pickVersion 同一优先级）。 */
export function pickTag(tagsJson: string): string {
  const order = ['next', 'latest', 'alpha'];
  for (const tag of order) {
    const m = new RegExp(`"${tag}"\\s*:\\s*"([^"]+)"`).exec(tagsJson);
    if (m) return m[1];
  }
  const any = /"[a-zA-Z0-9_-]+"\s*:\s*"(\d[^"]+)"/.exec(tagsJson);
  return any ? any[1] : '';
}

/**
 * 「下载对应运行时」的鸿蒙落点：查 npm dist-tags → 取该版本的前端产物 → 落沙箱 → 当本地产物用。
 *
 * 与桌面远程模式同形：不是从自己的 Host 拓文件，而是去**运行时包的分发处**取对应版本的那份产物；
 * 取完由调用方**重比**（入口产物名）——命中就用，仍不匹配就再问一次（桌面 ask_after_download）。
 */
export async function downloadFrontend(
  context: Context,
  base: string,
  cookie: string,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<LocalAssetBundle> {
  const metaUrl = `${NPM_REGISTRY}/${FRONTEND_PKG}`;
  const version = pickTag(await httpText(metaUrl, ''));
  if (version === '') throw new Error('npm 元数据里没有可用版本');
  const cdn = `${NPM_CDN}/${FRONTEND_PKG}@${version}/dist`;
  const html = await httpText(`${cdn}/index.html`, '');
  const entry = entryNameOf(html);
  if (entry === '') throw new Error(`包 ${version} 的 index.html 认不出入口产物`);

  const dir = distDirFor(context, entry);
  writeFile(dir, 'index.html', new util.TextEncoder().encodeInto(html).buffer as ArrayBuffer);

  const refs = assetPathsOf(html);
  const total = refs.length + 2; // index.html + 各资产 + 收尾写 manifest
  let done = 1;
  onProgress?.(done, total, 'index.html');
  for (const rel of refs) {
    writeFile(dir, rel, await httpBytes(`${cdn}/${rel}`));
    done++;
    onProgress?.(done, total, rel);

  }
  // 记下这次用的版本与入口：版本给冷启动读缓存用，入口给「与远端重比」用。
  await saveString(context, entryKey(base), entry);
  await saveString(context, `${entryKey(base)}:version`, version);
  return { dir: dir, entry: entry, files: listFiles(dir) };
}
