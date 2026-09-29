// 手机壳核心纯逻辑（自 shell-web/lib.mjs 移植，行为保持一致）：
// 配对输入解析、进入地址组装、配对列表存储（可注入存储适配器）。
// 平台无关：浏览器 / RN / vitest 均可直接使用。

export interface PairInput {
  token: string;
  base: string;
  /** http(s) 配对链接的完整 URL（/pair 自动种 cookie 后 302 进应用）；dsh-mobile:// 与手动输入无此字段。 */
  entryUrl?: string;
}

export interface PairEntry {
  token: string;
  base: string;
  name?: string;
  /** 以下均由壳探测对端得到（common/host-info.ts）；探测失败则保持缺省，界面回退到 name/base。 */
  lanIp?: string;
  lanePort?: number;
  tunnelUrl?: string;
  dshAuth?: boolean;
  /** 本机在**对端设备表**里的名字（对方看到你是谁）。 */
  deviceName?: string;
  /** 最后一次探测成功的时间（毫秒）。 */
  lastSeen?: number;
}

export interface PairStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PAIRS_KEY = 'dsh-mobile-pairs';
const ACTIVE_KEY = 'dsh-mobile-active';


/** 配对入口路径：历史 `/pair` 与保留命名空间 `/__dsh-mobile/pair`（均容忍末尾斜杠）。 */
const PAIR_ENTRY_PATHS = ['/pair', '/__dsh-mobile/pair'];
function isPairEntryPath(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') : pathname;
  return PAIR_ENTRY_PATHS.includes(p);
}
/**
 * 解析配对输入，支持三种形态 → { token, base, entryUrl? } | null
 *   dsh-mobile://pair?token=..&base=host:port[,host2:port]
 *   http(s)://host:port/pair?token=..（保留 entryUrl：先访问配对 URL 自动种 cookie）
 *   host:port（配合桌面显示的令牌单独输入，token 由 extraToken 提供）
 */
export function parsePairInput(input: string, extraToken = ''): PairInput | null {
  const s = String(input ?? '').trim();
  let token = '';
  let base = '';
  let entryUrl = '';
  if (s.startsWith('dsh-mobile://')) {
    const u = new URL(s);
    token = u.searchParams.get('token') ?? extraToken;
    base = u.searchParams.get('base') ?? '';
  } else if (/^https?:\/\//.test(s)) {
    const u = new URL(s);
    token = u.searchParams.get('token') ?? extraToken;
    // 配对入口的路径不能进 base：否则壳会拼出 http://host/__dsh-mobile/pair/ 这类
    // 「把入口当目录」的地址，配对路由不命中 → 反代门禁 401（实机踩过，#145 回归）。
    const entry = isPairEntryPath(u.pathname);
    base = entry ? u.host : u.host + u.pathname;
    // http 配对链接：进入时先访问完整 URL（配对入口自动种 cookie + 302 跳转）。
    if (entry && token) entryUrl = s;
  } else if (/^[^/\s]+:\d{1,5}$/.test(s)) {
    base = s;
    token = extraToken;
  } else {
    return null;
  }
  if (!token || !base) return null;
  const out: PairInput = { token, base };
  if (entryUrl) out.entryUrl = entryUrl;
  return out;
}

/**
 * 组装进入地址：优先配对 URL（自动配对种 cookie），否则直连 dsh 页面。
 */
export function buildEntryUrl(pair: PairInput, scheme = 'http'): string {
  return pair.entryUrl ?? buildEnterUrl(pair.base, scheme);
}

/**
 * 组装进入地址：http(s)://base/（dsh 页面；移动布局由注入的 dsh-mobile-nav 负责）
 */
export function buildEnterUrl(base: string, scheme = 'http'): string {
  return scheme + '://' + base + '/';
}

/**
 * 配对列表存储（默认内存；传入 storage 适配器可接 AsyncStorage / localStorage）
 */
export function createPairStore(storage?: PairStorage | null) {
  const mem = new Map<string, string>();
  const get = (k: string) => (storage ? storage.getItem(k) : mem.get(k));
  const set = (k: string, v: string) => {
    if (storage) storage.setItem(k, v);
    else mem.set(k, v);
  };
  return {
    list(): PairEntry[] {
      const raw = get(PAIRS_KEY) ?? '[]';
      try {
        return JSON.parse(raw) as PairEntry[];
      } catch {
        return [];
      }
    },
    add(pair: PairEntry): PairEntry[] {
      const list = this.list();
      // 同 base 已存在时**更新**（而不是丢弃）：设备信息（lanIp/隧道/对方看到的名字）是探测出来的，
      // 新一次探测必须能覆写旧值；只有 base 是身份键。
      const at = list.findIndex((p) => p.base === pair.base);
      if (at >= 0) list[at] = { ...list[at], ...pair };
      else list.push(pair);
      this.save(list);
      return list;
    },
    remove(base: string): void {
      this.save(this.list().filter((p) => p.base !== base));
    },
    save(list: PairEntry[]): void {
      set(PAIRS_KEY, JSON.stringify(list));
    },
    active(base?: string): void {
      set(ACTIVE_KEY, base ?? '');
    },
    activeBase(): string {
      return get(ACTIVE_KEY) ?? '';
    },
  };
}

/**
 * 从深链 URL 直接解析（App 冷启动 / 已运行时被 dsh-mobile:// 拉起时使用）
 */
export function parseDeepLink(url: string): PairInput | null {
  if (!url) return null;
  return parsePairInput(url);
}