import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entryName,
  mimeOf,
  buildGate,
  routeRequest,
  GATE_CHOICES,
  LOCAL_PLUGIN_PREFIX,
} from '../local-assets.mjs';
import {
  stripLanePatches,
  readBootGraph,
  augmentBootGraph,
  writeBootGraph,
  composeDocument,
  LANE_PATCH_MARKERS,
} from '../boot-manifest.mjs';

// 夹具取自 2026-09-29 从真实 lane（隔离实例 3191）抓的页面片段，不是编的。
const REAL_HEAD = [
  '<!doctype html><html lang="en"><head>',
  '<script data-dsh-mobile-owns-host="1">!function(){try{var g=globalThis,t=g.__DSH_TRANSPORT__;if(t&&typeof t==="object"){t.ownsHost=true;}else{g.__DSH_TRANSPORT__={ownsHost:true};}}catch(e){}}();</script>',
  '<script data-dsh-mobile-theme-sync="1">!function(){fetch("/__dsh-mobile/api/pair/info")}();</script>',
  '<script data-dsh-mobile-loopback="1">!function(){var P="/_loopback/";}();</script>',
  '<script data-dsh-mobile-polyfill="1">/* 老内核 polyfill，必须保留 */</script>',
  '<script type="module" src="./assets/index-3dwByubT.js"></script>',
  '<base href="./">',
  '<script>globalThis["__DSH_BOOT__"] = {"rev":"115a144154d7","entries":[{"id":"@deepseek-ai/dsh-client-ui-open-in-app","url":"plugins/??@deepseek-ai/dsh-client-ui-open-in-app/client.js&rev=195f14595521","rev":"195f14595521","inject":["@deepseek-ai/dsh-client-modules"]}],"batches":[{"phase":"application","url":"plugins/??a,b&rev=1","rev":"1","entries":["@deepseek-ai/dsh-client-ui-open-in-app"]}]}</script>',
  '</head><body><div id="root"></div></body></html>',
].join('');

test('entryName：只认 module 入口，忽略 combo 与注入行', () => {
  assert.equal(entryName(REAL_HEAD), 'index-3dwByubT.js');
  assert.equal(entryName('<script src="./assets/index-x.js"></script>'), null, '非 module 不算');
  assert.equal(entryName('<script type="module" src="/plugins/??dshmarket/client.js"></script>'), null);
  assert.equal(entryName('<script type="module" src="./assets/index-abc.js?v=1"></script>'), 'index-abc.js', 'query 要剥掉');
  assert.equal(entryName(''), null);
});

test('mimeOf：常见产物类型 + 未知兜底', () => {
  assert.equal(mimeOf('/assets/index-a.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeOf('assets/index-a.css?x=1'), 'text/css; charset=utf-8');
  assert.equal(mimeOf('f.woff2'), 'font/woff2');
  assert.equal(mimeOf('noext'), 'application/octet-stream');
});

test('buildGate：命中 / 缺产物 / 取不到标识', () => {
  const local = [{ id: '0.2.0-rc.2', entry: 'index-5SrrfWpU.js' }];
  assert.deepEqual(buildGate({ remoteEntry: 'index-5SrrfWpU.js', localDists: local }), {
    kind: 'matched',
    dist: local[0],
  });
  const miss = buildGate({ remoteEntry: 'index-9zzz.js', localDists: local });
  assert.equal(miss.kind, 'missing');
  assert.match(miss.reason, /index-9zzz\.js/);
  assert.equal(buildGate({ remoteEntry: null, localDists: local }).kind, 'unavailable');
  // 三选一与桌面远程模式同构
  assert.deepEqual(GATE_CHOICES.map((c) => c.id), ['download', 'useLocal', 'remoteWebview']);
});

test('routeRequest：本地资产优先，其余转发；随包插件走本地前缀', () => {
  const idx = { distFiles: ['assets/index-5SrrfWpU.js', 'assets/vendor-a.js'], localPlugins: ['dsh-web-mobile'] };
  assert.deepEqual(routeRequest('/assets/index-5SrrfWpU.js', idx), { kind: 'local', path: 'assets/index-5SrrfWpU.js' });
  assert.deepEqual(routeRequest('/assets/index-5SrrfWpU.js?v=1', idx), { kind: 'local', path: 'assets/index-5SrrfWpU.js' });
  // 不在本地索引里的产物（远程构建对不上时）→ 转发
  assert.equal(routeRequest('/assets/index-other.js', idx).kind, 'forward');
  // 文档 / API / 插件 combo 一律转发（文档由壳组装，数据在 Host）
  assert.equal(routeRequest('/', idx).kind, 'forward');
  assert.equal(routeRequest('/api/remote.mux', idx).kind, 'forward');
  assert.equal(routeRequest('/plugins/??a,b&rev=1', idx).kind, 'forward');
  // 随包插件
  assert.deepEqual(routeRequest(`${LOCAL_PLUGIN_PREFIX}dsh-web-mobile/client.js?rev=9`, idx), {
    kind: 'plugin',
    id: 'dsh-web-mobile',
    rest: '/client.js',
  });
  assert.deepEqual(routeRequest(`${LOCAL_PLUGIN_PREFIX}not-bundled/client.js`, idx), {
    kind: 'unknownPlugin',
    id: 'not-bundled',
  }, '自己的命名空间下未知 id 是终态，不转发（避免给 Host 制造噪声 404）');
});

test('stripLanePatches：剥三个 lane 补丁，保留 polyfill 与页面本体', () => {
  const out = stripLanePatches(REAL_HEAD);
  for (const m of LANE_PATCH_MARKERS) assert.ok(!out.includes(m), `${m} 必须剥掉`);
  assert.ok(out.includes('data-dsh-mobile-polyfill'), 'polyfill 是平台无关的，保留');
  assert.ok(out.includes('__DSH_BOOT__'), '启动图必须保留（Host 运行时的真实状态）');
  assert.ok(out.includes('<base href="./">'));
  assert.ok(out.includes('index-3dwByubT.js'));
});

test('readBootGraph：解析真实嵌入形态（字符串感知括号配对）', () => {
  const located = readBootGraph(REAL_HEAD);
  assert.ok(located, '应能取到启动图');
  assert.equal(located.graph.rev, '115a144154d7');
  assert.equal(located.graph.entries.length, 1);
  assert.equal(located.graph.batches[0].phase, 'application');
  // 字符串里带花括号也不能配错
  const tricky = '<script>globalThis["__DSH_BOOT__"] = {"rev":"a","note":"} not the end {","entries":[],"batches":[]}</script>';
  assert.equal(readBootGraph(tricky).graph.note, '} not the end {');
});

test('augmentBootGraph：补 entry + 独占 application batch；已有同 id 则不动', () => {
  const g = readBootGraph(REAL_HEAD).graph;
  const plugin = { id: 'dsh-web-mobile', url: '__local-plugins/dsh-web-mobile/client.js?rev=abc', rev: 'abc', inject: ['@deepseek-ai/dsh-client-modules'] };
  const { graph, added } = augmentBootGraph(g, plugin);
  assert.equal(added, true);
  const entry = graph.entries.find((e) => e.id === plugin.id);
  assert.deepEqual(entry.inject, ['@deepseek-ai/dsh-client-modules']);
  const batch = graph.batches.find((b) => b.url === plugin.url);
  assert.equal(batch.phase, 'application');
  assert.deepEqual(batch.entries, [plugin.id]);
  // 每个 entry 恰好属于一个 batch（前端 parseBootManifest 的硬约束）
  for (const e of graph.entries) {
    const owners = graph.batches.filter((b) => b.entries.includes(e.id));
    assert.equal(owners.length, 1, `entry ${e.id} 必须恰好属于一个 batch`);
  }
  // 原图不被就地改动
  assert.equal(g.entries.length, 1);
  // 幂等：Host 自己装了同 id 时不动它的图
  const again = augmentBootGraph(graph, plugin);
  assert.equal(again.added, false);
  assert.match(again.reason, /已有同 id/);
});

test('composeDocument：剥补丁 + 增补启动图 + 写回可再解析', () => {
  const plugin = { id: 'dsh-web-mobile', url: '__local-plugins/dsh-web-mobile/client.js?rev=abc', rev: 'abc' };
  const out = composeDocument({ remoteHtml: REAL_HEAD, localPlugin: plugin });
  assert.equal(out.stripped, true);
  assert.equal(out.bootAdded, true);
  assert.ok(!out.html.includes('data-dsh-mobile-owns-host'));
  const reparsed = readBootGraph(out.html);
  assert.ok(reparsed, '写回后仍应是合法启动图');
  assert.ok(reparsed.graph.entries.some((e) => e.id === 'dsh-web-mobile'));
  assert.ok(out.html.includes('index-3dwByubT.js'), '页面本体不动');
  // 不带随包插件时只剥补丁
  const bare = composeDocument({ remoteHtml: REAL_HEAD });
  assert.equal(bare.stripped, true);
  assert.equal(bare.bootAdded, false);
  assert.equal(readBootGraph(bare.html).graph.entries.length, 1);
});
