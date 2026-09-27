import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_PREFIX,
  LANE_ROUTE_PATHS,
  LANE_LEGACY_PATHS,
  lanePath,
  laneRoutePath,
  isReservedLanePath,
} from '../lib/lane-routes.mjs';

// #145：lane 控制面的「保留命名空间 + 冻结别名」契约。这组测试是「反代全量透传」
// 不变式的守门人——任何新增控制端点都必须落在 LANE_PREFIX 下，别名集合只减不增。

test('lane 路由：命名空间内一律命中，返回相对路径', () => {
  for (const relative of LANE_ROUTE_PATHS) {
    assert.equal(laneRoutePath(lanePath(relative)), relative, `命名空间命中 ${relative}`);
  }
});

test('lane 路由：冻结别名仍然命中（已发出的二维码与旧客户端）', () => {
  for (const legacy of LANE_LEGACY_PATHS) {
    assert.equal(laneRoutePath(legacy), legacy, `别名命中 ${legacy}`);
  }
  assert.deepEqual(
    [...LANE_LEGACY_PATHS].sort(),
    [...LANE_ROUTE_PATHS].sort(),
    '别名集合与路由表一一对应（新增路由不得只加别名）',
  );
  assert.ok(Object.isFrozen(LANE_LEGACY_PATHS) && Object.isFrozen(LANE_ROUTE_PATHS), '两张表都冻结');
});

test('lane 路由：命名空间外的路径一律不命中（交还反代透传）', () => {
  const notLane = [
    '/',
    '/index.html',
    '/api/settings/describe',
    '/api/session/list',
    '/api/remote.mux',
    '/api/pair', // 命名空间内的前缀本身不是路由
    '/api/pair/unknown', // 不在路由表 → 透传（匿名由反代门禁挡）
    '/__dsh-mobile/api/pair/unknown',
    '/__dsh-mobile',
    '/__dsh-mobilex/api/pair/info',
    '',
    'x',
  ];
  for (const p of notLane) {
    assert.equal(laneRoutePath(p), null, `不应命中：${p}`);
  }
  assert.equal(laneRoutePath(undefined), null);
  assert.equal(laneRoutePath(null), null);
});

test('lane 路由：保留命名空间形状（不与 dsh 路由同形）', () => {
  assert.ok(LANE_PREFIX.startsWith('/__'), '命名空间必须用双下划线前缀，避免与 dsh 路径碰撞');
  for (const relative of LANE_ROUTE_PATHS) {
    const canonical = lanePath(relative);
    assert.ok(canonical.startsWith(LANE_PREFIX + '/'), `规范路径位于命名空间内：${canonical}`);
    assert.ok(isReservedLanePath(canonical), `isReservedLanePath(${canonical})`);
    assert.ok(!isReservedLanePath(relative), `别名路径不算命名空间内：${relative}`);
  }
  assert.ok(isReservedLanePath(LANE_PREFIX), '命名空间根本身属于保留路径');
  assert.ok(!isReservedLanePath('/api/pair/info'), '历史别名不属于保留命名空间');
});

test('lane 路由：控制面端点集合是显式快照（新增必须同时改表与测试）', () => {
  assert.deepEqual(
    [...LANE_ROUTE_PATHS],
    [
      '/pair',
      '/api/pair/info',
      '/api/pair/accept',
      '/api/pair/mint',
      '/api/pair/probe',
      '/api/pair/tunnel',
      '/api/pair/devices',
      '/api/pair/remove',
      '/api/pair/stop',
      '/api/pair/events',
      '/api/pair/cloudflared',
    ],
    '路由表快照：新增控制端点会在此处显形，提醒同步透传不变式测试',
  );
});
