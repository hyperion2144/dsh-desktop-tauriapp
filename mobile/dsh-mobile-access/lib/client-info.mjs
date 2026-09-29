// 设备信息解析（#145 延伸）：把请求侧的 UA / IP / 入口类型解析成面板能展示的稳定字段。
//
// 为什么单独成模块：UA 形态极其繁杂（各家 App 内置 WebView、鸿蒙 ArkWeb、iPad 桌面模式伪装成
// Macintosh…），解析规则必须能被单测逐个形态锁死；而配对存储只该管「存/取/失效」。
// 纯函数、无 IO、无 Node 依赖（浏览器侧也能复用同一份判定语义）。

/** 平台标识 → 中文标签（面板展示用；未知一律「未知设备」）。 */
export const PLATFORM_LABEL = {
  ios: '苹果手机',
  ipados: '苹果平板',
  macos: 'Mac',
  android: '安卓',
  harmony: '鸿蒙',
  windows: 'Windows',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  shell: '桌面壳',
  browser: '浏览器',
  unknown: '未知设备',
};

/** 浏览器标识 → 展示名（空字符串 = 不展示）。 */
export const BROWSER_LABEL = {
  safari: 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  qq: 'QQ 浏览器',
  wechat: '微信',
  uc: 'UC 浏览器',
  arkweb: 'ArkWeb',
  androidWebview: 'Android WebView',
  appWebview: 'App WebView',
  unknown: '',
};

/** 接入路径 → 展示名。 */
export const ENTRY_LABEL = {
  local: '本机',
  lan: '局域网',
  tunnel: '隧道',
};

/**
 * 平台判定。顺序有意义：
 * 1. 空 UA = 壳自己的裸 TCP 换会话（没有 UA）→ shell；
 * 2. 鸿蒙先行：ArkWeb 的 UA 里同时含 Linux/Android 字样，先认鸿蒙免得被后两条抢走；
 * 3. iPad 桌面模式会伪装成 `Macintosh` 且带 `Mobile/` → 仍判 ipados。
 */
export function detectPlatform(ua = '') {
  const s = String(ua);
  if (!s.trim()) return 'shell';
  if (/HarmonyOS|OpenHarmony|ArkWeb|HMSCore/i.test(s)) return 'harmony';
  if (/iPad/i.test(s)) return 'ipados';
  if (/iPhone|iPod/i.test(s)) return 'ios';
  if (/Android/i.test(s)) return 'android';
  if (/Windows/i.test(s)) return 'windows';
  if (/CrOS/i.test(s)) return 'chromeos';
  if (/Macintosh/i.test(s)) return /Mobile\//.test(s) ? 'ipados' : 'macos';
  if (/Linux/i.test(s)) return 'linux';
  return 'browser';
}

/** 浏览器/WebView 判定（同样是顺序敏感：套壳 App 的标记要先于通用 Chrome/Safari）。 */
export function detectBrowser(ua = '') {
  const s = String(ua);
  if (!s.trim()) return 'unknown';
  if (/ArkWeb/i.test(s)) return 'arkweb';
  if (/MicroMessenger/i.test(s)) return 'wechat';
  if (/QQBrowser/i.test(s)) return 'qq';
  if (/UCBrowser|UBrowser/i.test(s)) return 'uc';
  if (/EdgiOS|Edg\//i.test(s)) return 'edge';
  if (/FxiOS|Firefox\//i.test(s)) return 'firefox';
  if (/CriOS|Chrome\//i.test(s)) return /; wv\)/i.test(s) ? 'androidWebview' : 'chrome';
  if (/Version\/[\d.]+.*Safari\//i.test(s)) return 'safari';
  if (/AppleWebKit/i.test(s)) return 'appWebview';
  return 'unknown';
}

/**
 * 安卓机型：从 UA 的平台段里挑「像机型号的那一段」。
 *
 * 为什么不能一条正则拍到：形态太杂——`Android 14; SM-S918B Build/...`、
 * `Android 13; Pixel 7 Build/...`、`Linux; U; Android 13; zh-cn; V2218A Build/...`（多一个语言段）、
 * 以及只有 `wv` 占位的 WebView。统一做法：切开平台段逐项排除（系统/语言/占位/构建号）。
 */
export function detectModel(ua = '') {
  const seg = /\(([^)]*Android[^)]*)\)/i.exec(String(ua));
  if (!seg) return '';
  const NOISE = /^(linux|x11|u|wv|mobile|android\s.*|[a-z]{2}(-[a-z]{2})?)$/i;
  for (const raw of seg[1].split(';')) {
    const part = raw.replace(/\s*Build[/].*$/i, '').trim();
    if (!part || NOISE.test(part) || /^Build\//i.test(part)) continue;
    return part;
  }
  return '';
}

/** 客户端 IP：隧道场景取 `x-forwarded-for` 第一跳，否则取 socket 对端（去掉 IPv6 映射前缀）。 */
export function clientIp(req) {
  const xff = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  if (xff) return xff;
  return String(req?.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** 接入路径：有 XFF = 走隧道；回环 = 本机；其余 = 局域网。 */
export function entryKind(req) {
  if (String(req?.headers?.['x-forwarded-for'] ?? '').trim()) return 'tunnel';
  const ip = clientIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1') return 'local';
  return 'lan';
}

/**
 * 汇总一台设备的面板信息。
 * @returns {{platform:string, platformLabel:string, browser:string, browserLabel:string,
 *   model:string, name:string, ip:string, entry:string, entryLabel:string}}
 */
export function describeClient({ ua = '', ip = '', entry = '' } = {}) {
  const platform = detectPlatform(ua);
  const browser = detectBrowser(ua);
  const model = detectModel(ua);
  const platformLabel = PLATFORM_LABEL[platform] ?? PLATFORM_LABEL.unknown;
  const browserLabel = BROWSER_LABEL[browser] ?? '';
  // 名字：能识别机型就用机型，否则用平台；再缀浏览器。壳没有 UA，直接叫「桌面壳（本机）」。
  const who = model || platformLabel;
  const name =
    platform === 'shell'
      ? '桌面壳（本机）'
      : browserLabel
        ? `${who} · ${browserLabel}`
        : who;
  return {
    platform,
    platformLabel,
    browser,
    browserLabel,
    model,
    name,
    ip,
    entry,
    entryLabel: ENTRY_LABEL[entry] ?? '',
  };
}
