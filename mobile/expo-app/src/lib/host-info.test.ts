// #155：远端设备信息探测的测试（fetch 从端口注入，node 里可跑；数据用实机响应的真实形状）。
import { describe, it, expect } from 'vitest';
import { parseHostInfo, probeHostInfo, lastDeviceName, type HostInfoFetch } from './host-info';

/** 实机 `/__dsh-mobile/api/pair/info` 的真实响应（2026-09-29 取值）。 */
const INFO_JSON =
  '{"lanePort":3092,"lanIp":"192.168.3.90","tunnelUrl":"https://bunny-vids-chen-james.trycloudflare.com","customTunnelUrl":"http://mutou-dsh.cpolar.top","uiTheme":null,"dshAuth":true}';

/** 实机设备表片段（pairing.json 的对外投影）。 */
const DEVICES_JSON =
  '{"devices":[{"deviceId":"913c2eaa","name":"浏览器","online":true},{"deviceId":"afdb6a35","name":"鸿蒙手机","online":true}]}';

describe('parseHostInfo', () => {
  it('取 lanIp/lanePort/dshAuth，并优先用自定义隧道地址', () => {
    const info = parseHostInfo(INFO_JSON, DEVICES_JSON);
    expect(info.lanIp).toBe('192.168.3.90');
    expect(info.lanePort).toBe(3092);
    expect(info.dshAuth).toBe(true);
    // 自定义隧道优先于内置隧道（与桌面设置里的取舍一致）
    expect(info.tunnelUrl).toBe('http://mutou-dsh.cpolar.top');
    // 本机在对方设备表里的名字（列表副标题会显示"对方看到：…"）
    expect(info.deviceName).toBe('鸿蒙手机');
  });

  it('没有自定义隧道时退回内置隧道；两者都空 = 只能直连', () => {
    const builtinOnly = parseHostInfo('{"tunnelUrl":"https://x.trycloudflare.com"}', '');
    expect(builtinOnly.tunnelUrl).toBe('https://x.trycloudflare.com');
    expect(parseHostInfo('{}', '').tunnelUrl).toBe('');
  });

  it('dshAuth 缺省视作 false；设备表为空时不编造名字', () => {
    const info = parseHostInfo('{"lanIp":"10.0.0.2"}', '');
    expect(info.dshAuth).toBe(false);
    expect(info.deviceName).toBe('');
    expect(info.lanePort).toBe(0);
  });
});

describe('lastDeviceName', () => {
  it('取最后一条（最近的配对会话通常就是本机）', () => {
    expect(lastDeviceName(DEVICES_JSON)).toBe('鸿蒙手机');
    expect(lastDeviceName('{"devices":[]}')).toBe('');
    expect(lastDeviceName('')).toBe('');
  });
});

describe('probeHostInfo', () => {
  function fakeFetch(routes: Record<string, { status: number; body: string }>): HostInfoFetch & { calls: string[] } {
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(url);
      const hit = routes[url];
      return {
        status: hit ? hit.status : 404,
        text: async () => (hit ? hit.body : ''),
      };
    }) as HostInfoFetch & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  it('走 lane 的两个接口，带壳持有的会话 cookie', async () => {
    const f = fakeFetch({
      'http://h:3092/__dsh-mobile/api/pair/info': { status: 200, body: INFO_JSON },
      'http://h:3092/__dsh-mobile/api/pair/devices': { status: 200, body: DEVICES_JSON },
    });
    // 断言请求头里的 cookie（探测必须带会话，否则 lane 回 401）
    const withHeaders = (async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.cookie).toBe('dsh_mobile_session=tok');
      return f(url, init);
    }) as HostInfoFetch;
    const info = await probeHostInfo('h:3092', 'dsh_mobile_session=tok', withHeaders);
    expect(info?.lanePort).toBe(3092);
    expect(f.calls).toHaveLength(2);
  });

  it('info 拿不到（未配对/不可达）→ null，调用方保持原样不清空', async () => {
    const f = fakeFetch({});
    expect(await probeHostInfo('h:3092', '', f)).toBeNull();
  });

  it('info 有、devices 挂了 → 仍返回信息（设备名字段留空，不编造）', async () => {
    const f = fakeFetch({
      'http://h:3092/__dsh-mobile/api/pair/info': { status: 200, body: INFO_JSON },
    });
    const info = await probeHostInfo('h:3092', '', f);
    expect(info?.lanIp).toBe('192.168.3.90');
    expect(info?.deviceName).toBe('');
  });
});
