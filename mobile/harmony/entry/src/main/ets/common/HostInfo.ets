/**
 * 远端设备信息探测（手机侧配对列表显示用）。
 *
 * 数据来源是 lane 的保留命名空间（唯一事实源：`mobile/dsh-mobile-access/lib/lane-routes.mjs`）：
 *   GET /__dsh-mobile/api/pair/info     → `{ lanePort, lanIp, tunnelUrl, customTunnelUrl, uiTheme, dshAuth }`
 *   GET /__dsh-mobile/api/pair/devices  → 设备表（含本机那条：name/platform/lastSeen/online）
 * 两个都是「已配对即放行」，所以带上壳里存的会话 cookie 去问。
 *
 * 为什么要探测而不是让用户看 `host:port`：桌面端列表显示的是**设备信息**（名字/平台/最近在线），
 * 手机端列表也该是同一层级的信息（对端是谁、走直连还是隧道、要不要会话鉴权、对方把我叫什么）。
 *
 * ArkTS 约束：不用 `JSON.parse` + 索引签名（会触发 arkts-no-props-by-index），用正则取值。
 */
import http from '@ohos.net.http';

/** 对端（Host）信息。 */
export interface HostInfo {
  /** 对端局域网 IPv4。 */
  lanIp: string;
  /** 对端 lane 端口。 */
  lanePort: number;
  /** 可用隧道地址（自定义优先，否则内置隧道）；空串 = 只能直连。 */
  tunnelUrl: string;
  /** 对端是否要求会话鉴权。 */
  dshAuth: boolean;
  /** 本机在**对端设备表**里的名字（对方看到你是谁）。 */
  deviceName: string;
}

/** 请求头（只带这两样）。 */
interface ProbeHeaders {
  accept?: string;
  cookie?: string;
}

async function getText(url: string, cookie: string): Promise<string> {
  const client = http.createHttp();
  try {
    const header: ProbeHeaders = { accept: 'application/json' };
    if (cookie !== '') header.cookie = cookie;
    const res = await client.request(url, {
      method: http.RequestMethod.GET,
      header: header,
      expectDataType: http.HttpDataType.STRING,
    });
    if ((res.responseCode as number) !== 200) return '';
    return res.result as string;
  } catch (err) {
    return ''; // 探测失败不该影响配对流程：调用方按「信息未知」显示
  } finally {
    client.destroy();
  }
}

function field(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return m ? m[1] : '';
}

function numberField(text: string, key: string): number {
  const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** 取设备表里**最后一条** `name`（最近的配对会话通常就是本机）。 */
function lastDeviceName(devicesJson: string): string {
  const names = devicesJson.match(/"name"\s*:\s*"[^"]*"/g);
  if (names === null || names.length === 0) return '';
  const last = names[names.length - 1];
  const m = /"name"\s*:\s*"([^"]*)"/.exec(last);
  return m ? m[1] : '';
}

/**
 * 探测对端信息；对端不可达或未授权时返回 null（调用方保持原有显示，不清空已有信息）。
 */
export async function probeHostInfo(base: string, cookie: string): Promise<HostInfo | null> {
  const info = await getText(`http://${base}/__dsh-mobile/api/pair/info`, cookie);
  if (info === '') return null;
  const devices = await getText(`http://${base}/__dsh-mobile/api/pair/devices`, cookie);
  const custom = field(info, 'customTunnelUrl');
  const builtin = field(info, 'tunnelUrl');
  return {
    lanIp: field(info, 'lanIp'),
    lanePort: numberField(info, 'lanePort'),
    tunnelUrl: custom !== '' ? custom : builtin,
    dshAuth: info.indexOf('"dshAuth":true') >= 0,
    deviceName: devices === '' ? '' : lastDeviceName(devices),
  };
}
