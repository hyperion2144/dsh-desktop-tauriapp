import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemote, selectLanIPv4, buildPairLink, buildHttpPairLink } from '../lib/links.mjs';

test('normalizeRemote：去 scheme、默认端口、拒绝非法', () => {
  assert.equal(normalizeRemote('http://192.168.1.10:8080'), '192.168.1.10:8080');
  assert.equal(normalizeRemote('192.168.1.10'), '192.168.1.10:3080');
  assert.equal(normalizeRemote('  https://x.y.cn '), 'x.y.cn:3080');
  assert.equal(normalizeRemote('x/path'), null);
  assert.equal(normalizeRemote('user@h'), null);
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('h:70000'), null);
});

test('selectLanIPv4：RFC1918 优先、物理网卡加分、VPN 减分', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Radmin VPN': [{ address: '26.3.9.8', family: 'IPv4', internal: false }],
    en0: [{ address: '169.254.9.9', family: 'IPv4', internal: false }, { address: '192.168.1.23', family: 'IPv4', internal: false }],
  };
  assert.equal(selectLanIPv4(ifaces), '192.168.1.23');
  const noLan = { en0: [{ address: '26.3.9.8', family: 'IPv4', internal: false }] };
  assert.equal(selectLanIPv4(noLan), '26.3.9.8');
  assert.equal(selectLanIPv4({}), null);
});

import { lanePath, laneRoutePath } from '../lib/lane-routes.mjs';

test('buildPairLink / buildHttpPairLink 编码', () => {
  const a = buildPairLink(['192.168.1.23:3091'], 'tok_1');
  assert.match(a, /^dsh-mobile:\/\/pair\?token=tok_1&base=192\.168\.1\.23%3A3091$/);
  const b = buildHttpPairLink('x.cn:3091', 't2');
  // #145：浏览器兜底链接改走保留命名空间；历史别名 /pair 仍被 lane 接受（已发出的二维码）
  assert.equal(b, 'http://x.cn:3091' + lanePath('/pair') + '?token=t2');
  assert.equal(laneRoutePath('/pair'), '/pair', '旧链接路径仍是 lane 路由（冻结别名）');
});

