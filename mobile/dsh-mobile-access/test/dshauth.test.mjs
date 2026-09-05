import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshUpstreamAuth } from '../lib/dshauth.mjs';

/** 可轮换的 dsh 鉴权剧本 fetch 桩：token 正确 → 303 + Set-Cookie；错误 → 401 无 Set-Cookie。 */
function makeFetch(state) {
  return async (u) => {
    const token = new URL(u).searchParams.get('token');
    if (token && token === state.token) {
      return {
        status: 303,
        headers: { getSetCookie: () => ['dshtest=' + state.secret + '; Path=/; HttpOnly; SameSite=Strict'] },
      };
    }
    return { status: 401, headers: { getSetCookie: () => [] } };
  };
}

test('dshauth 单元：交换 / applyTo 合并 / 轮换重换 / token 撤销降级 + 日志不泄露凭证', async () => {
  const state = { token: 'tok-A', secret: 'sA' };
  let enabled = true;
  const logs = [];
  const auth = createDshUpstreamAuth({
    origin: 'http://127.0.0.1:1',
    authenticatedUrl: () => (enabled ? 'http://127.0.0.1:1/?token=' + state.token : null),
    fetchImpl: makeFetch(state),
    log: (m) => logs.push(String(m)),
  });

  // 初始无凭证 → ensure 换取成功
  assert.equal(auth.hasCredential(), false);
  assert.equal(await auth.ensure(), true);
  assert.equal(auth.hasCredential(), true);

  // applyTo：同名对替换、异名对保留
  const h = { cookie: 'dsh_mobile_session=dev1; other=2' };
  auth.applyTo(h);
  assert.ok(h.cookie.includes('dsh_mobile_session=dev1'), '配对 cookie 保留');
  assert.ok(h.cookie.includes('other=2'), '其它 cookie 保留');
  assert.ok(h.cookie.includes('dshtest=sA'), 'dsh 凭证已附带');

  // 凭证轮换（模拟 dsh 重启换 token/secret）：refresh 重新自取并替换同名对
  state.token = 'tok-B';
  state.secret = 'sB';
  assert.equal(await auth.refresh(), true);
  const h2 = { cookie: 'dsh_mobile_session=dev1' };
  auth.applyTo(h2);
  assert.ok(h2.cookie.includes('dshtest=sB'), '新凭证已附带');
  assert.ok(!h2.cookie.includes('sA'), '旧凭证已被替换');

  // token 撤销（connection 不提供）→ 降级为无凭证
  enabled = false;
  assert.equal(await auth.refresh(), false);
  assert.equal(auth.hasCredential(), false);
  const h3 = { cookie: 'keep=1' };
  auth.applyTo(h3);
  assert.equal(h3.cookie, 'keep=1', '无凭证时不改写请求头');

  // 凭证纪律：日志只记状态，绝不含 token / cookie 值
  assert.ok(logs.length > 0, '状态日志已产生');
  for (const line of logs) {
    assert.ok(
      !line.includes('tok-A') && !line.includes('tok-B') && !line.includes('sA') && !line.includes('sB'),
      '日志不得包含凭证值: ' + line,
    );
  }
});

test('dshauth：token 错误（401 无 Set-Cookie）→ 交换失败返回 false', async () => {
  const state = { token: 'tok-right', secret: 'sX' };
  const auth = createDshUpstreamAuth({
    origin: 'http://127.0.0.1:1',
    // 模拟 token 已轮换但 authenticatedUrl 仍给旧值的错位场景
    authenticatedUrl: () => 'http://127.0.0.1:1/?token=tok-stale',
    fetchImpl: makeFetch(state),
  });
  assert.equal(await auth.ensure(), false);
  assert.equal(auth.hasCredential(), false);
});

test('dshauth：authenticatedUrl 缺失（老版 dsh / 独立运行）→ 无凭证降级', async () => {
  const auth = createDshUpstreamAuth({ origin: 'http://127.0.0.1:1' });
  assert.equal(await auth.ensure(), false);
  assert.equal(auth.hasCredential(), false);
  const h = { cookie: 'a=1' };
  auth.applyTo(h);
  assert.equal(h.cookie, 'a=1');
});
