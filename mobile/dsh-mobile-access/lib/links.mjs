// 地址/链接相关纯函数：归一化、局域网 IP 挑选、配对链接与二维码文本。
// 自实现（不拷贝 dsh-pocket 源码；仅对齐其行为约定）。

import { lanePath } from './lane-routes.mjs';

const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PHYSICAL_IFACE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|本地连接)/i;
const VPN_IFACE = /(?:radmin|tailscale|zerotier|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

/** 归一化远程地址：去 scheme、拒绝路径/凭据/空白；端口默认 3080。返回 host:port 或 null。 */
export function normalizeRemote(input) {
  let a = String(input ?? '').trim();
  for (const p of ['https://', 'http://']) {
    if (a.startsWith(p)) { a = a.slice(p.length); break; }
  }
  if (!a || a.includes('/') || a.includes('@') || a.includes(' ') || a.includes('?') || a.includes('#')) return null;
  const m = a.match(/^([^:]+):(\d{1,5})$/);
  if (m) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return null;
    return m[1] + ':' + port;
  }
  return a + ':3080';
}

/** 从 os.networkInterfaces() 选手机最可能可达的 IPv4（RFC1918 优先、物理网卡加分、VPN 减分）。 */
export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      let score = 0;
      if (PRIVATE_IPV4.test(ip)) score += 100;
      if (PHYSICAL_IFACE.test(name)) score += 20;
      else if (VPN_IFACE.test(name)) score -= 50;
      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

/** 配对链接（手机壳 dsh-mobile:// 形态，含 base 候选列表）。 */
export function buildPairLink(bases, token) {
  const joined = Array.isArray(bases) ? bases.join(',') : String(bases ?? '');
  const q = new URLSearchParams({ token });
  if (joined) q.set('base', joined);
  return 'dsh-mobile://pair?' + q.toString();
}

/** 浏览器兜底配对链接（http 形态，指向反代保留命名空间下的配对入口）。
 *  历史别名 `/pair` 仍被 lane 接受（已发出的二维码），新链接一律走命名空间。 */
export function buildHttpPairLink(base, token) {
  return 'http://' + base + lanePath('/pair') + '?token=' + encodeURIComponent(token);
}

/** UI 展示用链接（避免长路径）。 */
export function qrText(link) { return link; }