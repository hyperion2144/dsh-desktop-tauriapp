import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairInput, buildEnterUrl, buildEntryUrl, createPairStore } from '../lib.mjs';

test('parsePairInput 三种形态', () => {
  const a = parsePairInput('dsh-mobile://pair?token=t1&base=192.168.1.23%3A3091');
  assert.deepEqual(a, { token: 't1', base: '192.168.1.23:3091' });
  const b = parsePairInput('https://x.cn:8080/pair?token=t2');
  assert.deepEqual(b, { token: 't2', base: 'x.cn:8080', entryUrl: 'https://x.cn:8080/pair?token=t2' });
  const c = parsePairInput('192.168.1.23:3091', 'tok3');
  assert.deepEqual(c, { token: 'tok3', base: '192.168.1.23:3091' });
  assert.equal(parsePairInput('乱写'), null);
  assert.equal(parsePairInput('x.cn:8080'), null); // 无令牌
});

test('buildEnterUrl / buildEntryUrl', () => {
  assert.equal(buildEnterUrl('a.cn:3091'), 'http://a.cn:3091/');
  // entryUrl 优先（自动配对后再进应用）
  assert.equal(buildEntryUrl({ token: 't', base: 'a.cn:3091', entryUrl: 'https://a.cn:3091/pair?token=t' }), 'https://a.cn:3091/pair?token=t');
  // 无 entryUrl（dsh-mobile:// 或已保存配对）→ 直连
  assert.equal(buildEntryUrl({ token: 't', base: 'a.cn:3091' }), 'http://a.cn:3091/');
});

test('createPairStore（内存适配器）', () => {
  const store = createPairStore(null);
  store.add({ token: 't', base: 'a.cn:3091', name: '家里' });
  store.add({ token: 't', base: 'b.cn:3091', name: '公司' });
  store.add({ token: 't', base: 'a.cn:3091', name: '家里' }); // 去重
  assert.equal(store.list().length, 2);
  store.active('a.cn:3091');
  assert.equal(store.activeBase(), 'a.cn:3091');
  store.remove('a.cn:3091');
  assert.equal(store.list().length, 1);
});

test('parsePairInput：配对入口不污染 base（含命名空间形态与末尾斜杠）', () => {
  // 历史形态：入口路径不进 base，且保留 entryUrl 以便自动配对
  const legacy = parsePairInput('http://192.168.3.90:3092/pair?token=t1');
  assert.equal(legacy.base, '192.168.3.90:3092');
  assert.equal(legacy.entryUrl, 'http://192.168.3.90:3092/pair?token=t1');
  // 保留命名空间形态（#145）：同样不得把入口当目录
  const ns = parsePairInput('http://192.168.3.90:3092/__dsh-mobile/pair?token=t2');
  assert.equal(ns.base, '192.168.3.90:3092');
  assert.equal(ns.entryUrl, 'http://192.168.3.90:3092/__dsh-mobile/pair?token=t2');
  // 末尾斜杠（ArkWeb/WebView 归一化）：仍然认作配对入口
  const slash = parsePairInput('http://192.168.3.90:3092/__dsh-mobile/pair/?token=t3');
  assert.equal(slash.base, '192.168.3.90:3092');
  assert.equal(slash.entryUrl, 'http://192.168.3.90:3092/__dsh-mobile/pair/?token=t3');
  // 非配对路径：整条路径进 base（子路径部署仍可用）
  const sub = parsePairInput('http://x.cn:3091/gw?token=t4');
  assert.equal(sub.base, 'x.cn:3091/gw');
  assert.equal(sub.entryUrl, undefined);
  // dsh-mobile:// 深链不受影响
  const deep = parsePairInput('dsh-mobile://pair?token=t5&base=a.cn:3091');
  assert.equal(deep.base, 'a.cn:3091');
  assert.equal(deep.entryUrl, undefined);
});
