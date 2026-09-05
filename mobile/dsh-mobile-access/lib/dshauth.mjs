// dsh web 会话凭证持有者（dsh 0.1.2-rc.1+ token 鉴权适配）：
//   - 进程内自取 process token（connection 服务 authenticatedUrl）→ GET /?token= 换会话 cookie；
//   - cookie 仅存内存（不落盘、不进日志）；lane 与 dsh 同进程生命周期，重启即随启随取；
//   - applyTo(headers) 把 cookie 合并进反代上游请求头；refresh() 清旧值重新自取（token 轮换安全）。
// 降级：connection 服务不可用或未提供 token → 无凭证运行（老版 dsh 无鉴权，行为不变）。
// 纪律：任何日志只记状态，绝不记录 token / cookie 值。

export function createDshUpstreamAuth({ origin, authenticatedUrl = null, fetchImpl = null, log = null }) {
  let cookiePair = null; // "name=value"，取自交换响应 Set-Cookie 首段
  const doFetch = fetchImpl ?? ((u, o) => fetch(u, o));
  const say = (m) => { try { if (m) log?.('[dsh-mobile-access] ' + m); } catch { /* noop */ } };

  function tokenFrom(url) {
    if (!url) return '';
    try {
      return new URL(String(url), origin).searchParams.get('token') ?? '';
    } catch {
      return '';
    }
  }

  /** 用 token 换会话 cookie（不跟随重定向，取 Set-Cookie 首段 name=value）。 */
  async function exchange(token) {
    if (!token) return false;
    try {
      const res = await doFetch(origin + '/?token=' + encodeURIComponent(token), {
        redirect: 'manual',
        headers: { connection: 'close' },
      });
      let lines = [];
      try {
        if (typeof res.headers?.getSetCookie === 'function') lines = res.headers.getSetCookie();
        else if (res.headers?.get?.('set-cookie')) lines = [res.headers.get('set-cookie')];
      } catch { /* noop */ }
      for (const line of lines) {
        const pair = String(line).split(';')[0].trim();
        const eq = pair.indexOf('=');
        if (eq > 0 && !/^(path|expires|max-age|httponly|samesite|secure|domain)$/i.test(pair.slice(0, eq).trim())) {
          cookiePair = pair;
          say('dsh 会话凭证已获得');
          return true;
        }
      }
      say('dsh 凭证交换失败：HTTP ' + res.status + '（无 Set-Cookie）');
    } catch (e) {
      say('dsh 凭证交换失败：' + (e?.message ?? e));
    }
    return false;
  }

  /** 清旧值并重新自取 token（authenticatedUrl 每次现取，token 轮换/重启后依然正确）。 */
  async function acquire() {
    cookiePair = null;
    let url = null;
    try {
      url = authenticatedUrl?.(origin) ?? null;
    } catch {
      url = null;
    }
    const token = tokenFrom(url);
    if (!token) {
      say('connection 服务未提供 process token，lane 以无凭证模式运行');
      return false;
    }
    return exchange(token);
  }

  /** 已持有凭证 → true；否则尝试获取（懒获取，401 自愈的常规前置）。 */
  async function ensure() {
    if (cookiePair) return true;
    return acquire();
  }

  /** 凭证失效（上游 401）→ 清旧值重新交换；失败返回 false（调用方透传 401）。 */
  async function refresh() {
    return acquire();
  }

  /** 把持有的 cookie 合并进上游请求头：替换同名对，保留其余（配对 cookie 等不丢）。 */
  function applyTo(headers) {
    if (!cookiePair) return headers;
    const name = cookiePair.slice(0, cookiePair.indexOf('=')).trim();
    const kept = String(headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => {
        const i = p.indexOf('=');
        return i <= 0 || p.slice(0, i).trim() !== name;
      });
    kept.push(cookiePair);
    headers.cookie = kept.join('; ');
    return headers;
  }

  /** 是否持有凭证（仅状态布尔，供 probe/info 端点暴露排查）。 */
  function hasCredential() {
    return !!cookiePair;
  }

  return { ensure, refresh, applyTo, hasCredential };
}
