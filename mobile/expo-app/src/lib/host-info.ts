// 远端设备信息探测（手机侧配对列表显示用；与鸿蒙 `common/HostInfo.ets` 同源同形）。
//
// 数据来源是 lane 的保留命名空间（唯一事实源：`mobile/dsh-mobile-access/lib/lane-routes.mjs`）：
//   GET /__dsh-mobile/api/pair/info     → `{ lanePort, lanIp, tunnelUrl, customTunnelUrl, uiTheme, dshAuth }`
//   GET /__dsh-mobile/api/pair/devices  → 设备表（含本机那条：name/platform/lastSeen/online）
// 两个都是「已配对即放行」，所以带上壳里存的会话 cookie 去问。
//
// 为什么探测而不是只显示 `host:port`：桌面端列表显示的是**设备信息**（名字/平台/最近在线），
// 手机端也该是同一层级（对端是谁、走直连还是隧道、要不要会话鉴权、对方把我叫什么）。
//
// fetch 从端口注入，因此本模块能在 node（vitest）里逐条测。
// lane 保留命名空间（唯一事实源 `mobile/dsh-mobile-access/lib/lane-routes.mjs` 的 LANE_PREFIX，冻结不改）。
// 这里重复一个字面量而不是跨包 import：那个模块是 node 侧插件代码，Metro 打包链路里不该被拖进来。
const LANE_PREFIX = '/__dsh-mobile';

/** 对端（Host）信息。 */
export interface HostInfo {
  lanIp: string;
  lanePort: number;
  /** 可用隧道地址（自定义优先，否则内置隧道）；空串 = 只能直连。 */
  tunnelUrl: string;
  dshAuth: boolean;
  /** 本机在**对端设备表**里的名字（对方看到你是谁）。 */
  deviceName: string;
}

export interface HostInfoFetch {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    status: number;
    text(): Promise<string>;
  }>;
}

/** 从 JSON 文本里取字符串/数字字段（不 JSON.parse：形状未知时正则更稳，也与鸿蒙侧一致）。 */
function field(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return m ? m[1] : '';
}

function numberField(text: string, key: string): number {
  const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** 取设备表里**最后一条** `name`（最近的配对会话通常就是本机）。 */
export function lastDeviceName(devicesJson: string): string {
  const all = devicesJson.match(/"name"\s*:\s*"[^"]*"/g);
  if (all === null || all.length === 0) return '';
  const m = /"name"\s*:\s*"([^"]*)"/.exec(all[all.length - 1]);
  return m ? m[1] : '';
}

/** 把两条接口的响应文本拼成 `HostInfo`（纯函数，便于单测）。 */
export function parseHostInfo(infoJson: string, devicesJson: string): HostInfo {
  const custom = field(infoJson, 'customTunnelUrl');
  const builtin = field(infoJson, 'tunnelUrl');
  return {
    lanIp: field(infoJson, 'lanIp'),
    lanePort: numberField(infoJson, 'lanePort'),
    tunnelUrl: custom !== '' ? custom : builtin,
    dshAuth: infoJson.indexOf('"dshAuth":true') >= 0,
    deviceName: devicesJson === '' ? '' : lastDeviceName(devicesJson),
  };
}

async function getText(url: string, cookie: string, fetchImpl: HostInfoFetch): Promise<string> {
  try {
    const res = await fetchImpl(
      url,
      cookie === '' ? undefined : { headers: { cookie } },
    );
    if (res.status !== 200) return '';
    return await res.text();
  } catch {
    return ''; // 探测失败不该影响配对流程：调用方保持「信息未知」
  }
}

/**
 * 探测对端信息；对端不可达或未授权时返回 null（调用方**不清空**已有信息）。
 */
export async function probeHostInfo(
  base: string,
  cookie: string,
  fetchImpl: HostInfoFetch,
): Promise<HostInfo | null> {
  const info = await getText(`http://${base}${LANE_PREFIX}/api/pair/info`, cookie, fetchImpl);
  if (info === '') return null;
  const devices = await getText(`http://${base}${LANE_PREFIX}/api/pair/devices`, cookie, fetchImpl);
  return parseHostInfo(info, devices);
}
