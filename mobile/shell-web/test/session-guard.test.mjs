import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKOFF_CAP_MS,
  GUARD_ACTION,
  GUARD_MESSAGE_PREFIX,
  GUARD_PROBE_TIMEOUT_MS,
  actionForReading,
  backoffDelayMs,
  buildGuardProbeScript,
  buildGuardProbeWithPostMessageScript,
  buildLightReconnectScript,
  parseGuardProbeResult,
  shouldEscalateToReload,
} from '../session-guard.mjs';

// #144：会话守卫的判定/退避/脚本契约。两端（鸿蒙 ArkTS、expo TS）按本文件的语义移植，
// 因此这里的每个断言都是「两端必须一致」的那部分。

test('退避：前两次不等待，之后指数增长并封顶', () => {
  assert.equal(backoffDelayMs(0), 0);
  assert.equal(backoffDelayMs(1), 0);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
  assert.equal(backoffDelayMs(5), 16000);
  assert.equal(backoffDelayMs(9), BACKOFF_CAP_MS, '指数增长封顶 30s');
  assert.equal(backoffDelayMs(Number.NaN), 0);
});

test('探针读数解析：合法形态保留，其余一律 null（绝不误判健康）', () => {
  assert.equal(parseGuardProbeResult('ds|1|12.3'), 'ds|1|12.3');
  assert.equal(parseGuardProbeResult('"ds0|0|-"'), 'ds0|0|-');
  assert.equal(parseGuardProbeResult('err|1|88'), 'err|1|88');
  assert.equal(parseGuardProbeResult('off|0|-'), 'off|0|-');
  assert.equal(parseGuardProbeResult('null|1|-'), 'null|1|-');
  assert.equal(parseGuardProbeResult('ds|2|-'), null, '在线位只能是 0/1');
  assert.equal(parseGuardProbeResult('ready|1|-'), null, '未知信号');
  assert.equal(parseGuardProbeResult('ds|1'), null, '缺段');
  assert.equal(parseGuardProbeResult(''), null);
  assert.equal(parseGuardProbeResult(undefined), null);
  assert.equal(parseGuardProbeResult(null), null);
});

test('判定表：健康不动手、掉线轻量重连、无网等网络、读不到才兜底重载', () => {
  assert.equal(actionForReading('ds|1|12'), GUARD_ACTION.NONE);
  assert.equal(actionForReading('ds0|1|12'), GUARD_ACTION.RECONNECT, '页面在但客户端没起来 → 轻量重连');
  assert.equal(actionForReading('err|1|-'), GUARD_ACTION.RECONNECT, '探针请求失败 → 轻量重连');
  assert.equal(actionForReading('off|0|-'), GUARD_ACTION.WAIT_NETWORK);
  assert.equal(actionForReading('null|1|-'), GUARD_ACTION.RELOAD, '页面无响应 → 兜底重载');
  assert.equal(actionForReading(null), GUARD_ACTION.RELOAD, '注入失败/解析失败 → 兜底重载');
  assert.equal(actionForReading('ds'), GUARD_ACTION.RELOAD, '残缺读数 → 兜底重载');
});

test('升级为兜底重载：只有连续多次轻量重连仍失败才升级', () => {
  assert.equal(shouldEscalateToReload(1, 1), false);
  assert.equal(shouldEscalateToReload(3, 2), false);
  assert.equal(shouldEscalateToReload(2, 3), false);
  assert.equal(shouldEscalateToReload(3, 3), true);
  assert.equal(shouldEscalateToReload(5, 4), true);
});

test('探针脚本：单行、走 mux 端点、带启动标记与超时', () => {
  const s = buildGuardProbeScript();
  assert.ok(!s.includes('\n'), '注入脚本必须单行');
  assert.ok(s.includes('/api/remote.mux'));
  assert.ok(s.includes('__DSH_BOOT__'));
  assert.ok(s.includes(String(GUARD_PROBE_TIMEOUT_MS)));
  assert.ok(s.includes('navigator.onLine'));
  assert.ok(s.includes('cache:"no-store"'));
});

test('轻量重连脚本：派发 offline→online 事件对，不整页重载', () => {
  const s = buildLightReconnectScript();
  assert.ok(!s.includes('\n'), '注入脚本必须单行');
  assert.ok(s.includes('dispatchEvent'));
  assert.ok(s.includes('"offline"') && s.includes('"online"'));
  assert.ok(!s.includes('location.reload'), '轻量重连绝不整页重载');
});

test('RN 回传包装：走 postMessage + 固定标签', () => {
  const s = buildGuardProbeWithPostMessageScript();
  assert.ok(!s.includes('\n'), '注入脚本必须单行');
  assert.ok(s.includes('ReactNativeWebView.postMessage'));
  assert.ok(s.includes(GUARD_MESSAGE_PREFIX));
  assert.ok(s.includes('__DSH_BOOT__'), '仍复用同一份探针语义');
});
