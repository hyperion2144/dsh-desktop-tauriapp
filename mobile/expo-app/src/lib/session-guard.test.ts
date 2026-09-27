import { test, expect } from 'vitest';
import {
  BACKOFF_CAP_MS,
  GUARD_MESSAGE_PREFIX,
  GUARD_PROBE_TIMEOUT_MS,
  actionForReading,
  backoffDelayMs,
  buildGuardProbeScript,
  buildLightReconnectScript,
  parseGuardProbeResult,
  readingFromMessage,
  shouldEscalateToReload,
} from './session-guard';

// 语义源：mobile/shell-web/session-guard.mjs（那份有 node:test 版本）。这里用同一组断言复验，
// 保证 expo 壳的判定与共享逻辑源不漂移。

test('退避：前两次不等待，之后指数增长并封顶', () => {
  expect(backoffDelayMs(0)).toBe(0);
  expect(backoffDelayMs(1)).toBe(0);
  expect(backoffDelayMs(2)).toBe(2000);
  expect(backoffDelayMs(3)).toBe(4000);
  expect(backoffDelayMs(4)).toBe(8000);
  expect(backoffDelayMs(9)).toBe(BACKOFF_CAP_MS);
  expect(backoffDelayMs(Number.NaN)).toBe(0);
});

test('探针读数解析：合法形态保留，其余一律 null', () => {
  expect(parseGuardProbeResult('ds|1|12.3')).toBe('ds|1|12.3');
  expect(parseGuardProbeResult('"ds0|0|-"')).toBe('ds0|0|-');
  expect(parseGuardProbeResult('err|1|88')).toBe('err|1|88');
  expect(parseGuardProbeResult('ds|2|-')).toBeNull();
  expect(parseGuardProbeResult('ready|1|-')).toBeNull();
  expect(parseGuardProbeResult('')).toBeNull();
  expect(parseGuardProbeResult(null)).toBeNull();
});

test('判定表：健康不动手、掉线轻量重连、无网等网络、只有完全没回消息才兜底重载', () => {
  expect(actionForReading('ds|1|12')).toBe('none');
  expect(actionForReading('ds0|1|12')).toBe('reconnect');
  expect(actionForReading('err|1|-')).toBe('reconnect');
  expect(actionForReading('off|0|-')).toBe('wait-network');
  // 关键回归：页面回了 null（它自己的探测请求超时）证明页面活着 → 轻量重连，不整页重载
  expect(actionForReading('null|1|-')).toBe('reconnect');
  expect(actionForReading(null)).toBe('reload');
  expect(actionForReading('ds')).toBe('reload');
});

test('升级为兜底重载：只有连续多次轻量重连仍失败才升级', () => {
  expect(shouldEscalateToReload(1, 1)).toBe(false);
  expect(shouldEscalateToReload(3, 2)).toBe(false);
  expect(shouldEscalateToReload(3, 3)).toBe(true);
});

test('探针脚本：单行、postMessage 回传、走 mux 端点、带超时', () => {
  const s = buildGuardProbeScript();
  expect(s.includes('\n')).toBe(false);
  expect(s).toContain('ReactNativeWebView.postMessage');
  expect(s).toContain('/api/remote.mux');
  expect(s).toContain('__DSH_BOOT__');
  expect(s).toContain(String(GUARD_PROBE_TIMEOUT_MS));
});

test('轻量重连脚本：offline→online 事件对，绝不整页重载', () => {
  const s = buildLightReconnectScript();
  expect(s.includes('\n')).toBe(false);
  expect(s).toContain('dispatchEvent');
  expect(s).toContain('"offline"');
  expect(s).toContain('"online"');
  expect(s).not.toContain('location.reload');
});

test('postMessage 读数提取：只认本守卫标签', () => {
  expect(readingFromMessage(GUARD_MESSAGE_PREFIX + 'ds|1|9')).toBe('ds|1|9');
  expect(readingFromMessage('别的消息')).toBeNull();
  expect(readingFromMessage(GUARD_MESSAGE_PREFIX + 'garbage')).toBeNull();
  expect(readingFromMessage(123)).toBeNull();
});
