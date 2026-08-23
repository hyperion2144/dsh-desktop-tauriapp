// 配对核心逻辑（自 shell-web/lib.mjs 移植为 ArkTS，行为保持一致）。
// 纯逻辑：配对输入解析、进入地址组装；存储由调用方注入（preferences 适配）。
// URL 解析按 @ohos.url 现代 API：url.URL.parseURL() + URLParams.get()（searchParams 自 API9 废弃）。
import { url } from '@kit.ArkTS';

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
  entryUrl?: string;
}

export interface PairStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PAIRS_KEY = 'dsh-mobile-pairs';
const ACTIVE_KEY = 'dsh-mobile-active';

function hashCodeOfBase(base: string): string {
  // 供去重比较用的稳定 key（直接比较 base 字符串即可，此函数保留语义占位）
  return base;
}

export class PairLogic {
  static parsePairInput(input: string, extraToken: string = ''): PairInput | null {
    const s = (input ?? '').trim();
    let token = '';
    let base = '';
    let entryUrl = '';
    if (s.startsWith('dsh-mobile://')) {
      const u: url.URL = url.URL.parseURL(s);
      token = u.params.get('token') ?? extraToken;
      base = u.params.get('base') ?? '';
    } else if (/^https?:\/\//.test(s)) {
      const u: url.URL = url.URL.parseURL(s);
      token = u.params.get('token') ?? extraToken;
      const path = u.pathname === '/pair' ? '' : u.pathname;
      base = u.host + path;
      // http 配对链接：进入时先访问完整 URL（/pair 自动配对 + 种 cookie + 302 跳转）。
      if (u.pathname === '/pair' && token !== '') entryUrl = s;
    } else if (/^[^/\s]+:\d{1,5}$/.test(s)) {
      base = s;
      token = extraToken;
    } else {
      return null;
    }
    if (!token || !base) return null;
    const out: PairInput = { token: token, base: base };
    if (entryUrl !== '') out.entryUrl = entryUrl;
    return out;
  }

  static buildEntryUrl(pair: PairInput, scheme: string = 'http'): string {
    return pair.entryUrl ?? (scheme + '://' + pair.base + '/');
  }

  static buildEnterUrl(base: string, scheme: string = 'http'): string {
    return scheme + '://' + base + '/';
  }
}

/**
 * 配对列表存储（内存态；storage 适配器负责持久化，如 preferences）。
 * 具名类：避免对象字面量 + this 在部分 ArkTS lint 下的兼容风险。
 */
export class PairStore {
  private storage: PairStorage | null;
  private mem: Map<string, string> = new Map();

  constructor(storage: PairStorage | null) {
    this.storage = storage;
  }

  private get(key: string): string | null {
    if (this.storage != null) return this.storage.getItem(key);
    return this.mem.get(key) ?? null;
  }

  private set(key: string, value: string): void {
    if (this.storage != null) {
      this.storage.setItem(key, value);
    } else {
      this.mem.set(key, value);
    }
  }

  list(): PairEntry[] {
    const raw = this.get(PAIRS_KEY) ?? '[]';
    try {
      return JSON.parse(raw) as PairEntry[];
    } catch {
      return [];
    }
  }

  add(pair: PairEntry): PairEntry[] {
    const list = this.list();
    if (!list.some((p) => hashCodeOfBase(p.base) === hashCodeOfBase(pair.base))) {
      list.push(pair);
    }
    this.save(list);
    return list;
  }

  remove(base: string): void {
    this.save(this.list().filter((p) => p.base !== base));
  }

  save(list: PairEntry[]): void {
    this.set(PAIRS_KEY, JSON.stringify(list));
  }

  active(base?: string): void {
    this.set(ACTIVE_KEY, base ?? '');
  }

  activeBase(): string {
    return this.get(ACTIVE_KEY) ?? '';
  }
}

export function createPairStore(storage: PairStorage | null): PairStore {
  return new PairStore(storage);
}