// H5 手机壳核心纯逻辑：配对输入解析、进入地址组装、配对列表存储（可注入存储适配器）。

// 解析配对输入：支持三种形态 → { token, base, entryUrl? } | null
//   dsh-mobile://pair?token=..&base=host:port[,host2:port]
//   http(s)://host:port/pair?token=..（保留 entryUrl：先访问配对 URL 自动种 cookie）
//   host:port（配合桌面显示的令牌单独输入）

/** 配对入口路径：历史 `/pair` 与保留命名空间 `/__dsh-mobile/pair`（均容忍末尾斜杠）。 */
const PAIR_ENTRY_PATHS = ['/pair', '/__dsh-mobile/pair'];

function isPairEntryPath(pathname) {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') : pathname;
  return PAIR_ENTRY_PATHS.includes(p);
}

export function parsePairInput(input, extraToken = '') {
  const s = String(input ?? '').trim();
  let token = '', base = '', entryUrl = '';
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
  const out = { token, base };
  if (entryUrl) out.entryUrl = entryUrl;
  return out;
}

// 组装进入地址：优先配对 URL（自动配对种 cookie），否则直连 dsh 页面。
export function buildEntryUrl(pair, scheme = 'http') {
  return pair.entryUrl || buildEnterUrl(pair.base, scheme);
}

// 组装进入地址：http(s)://base/（dsh 页面；移动布局由注入的 dsh-mobile-nav 负责）
export function buildEnterUrl(base, scheme = 'http') {
  return scheme + '://' + base + '/';
}

// 配对列表存储（默认 localStorage；测试可传入内存适配器）
export function createPairStore(storage) {
  const mem = new Map();
  const get = (k) => (storage ? storage.getItem(k) : mem.get(k));
  const set = (k, v) => (storage ? storage.setItem(k, v) : mem.set(k, v));
  return {
    list: () => { const raw = get('dsh-mobile-pairs') ?? '[]'; try { return JSON.parse(raw); } catch { return []; } },
    add(pair) {
      const list = this.list();
      if (!list.some((p) => p.base === pair.base)) list.push(pair);
      this.save(list);
      return list;
    },
    remove(base) { this.save(this.list().filter((p) => p.base !== base)); },
    save(list) { set('dsh-mobile-pairs', JSON.stringify(list)); },
    active: (base) => set('dsh-mobile-active', base ?? ''),
    activeBase: () => get('dsh-mobile-active') ?? '',
  };
}