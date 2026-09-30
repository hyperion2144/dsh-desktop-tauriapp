// 把「内置运行时」的前端产物 + 布局插件打成**一个包**放进 App 资源（#155：随包分发）。
//
// 为什么用一个归档而不是一堆文件：
//   ① 与鸿蒙侧同形——内置的就是**完整运行时**，运行时以后增减文件**不需要改代码**；
//   ② RN 的静态资源要 `require()` 才有清单，逐文件 require 等于把文件表写死在代码里（正是要避免的）。
// 运行时侧由 `src/lib/builtin-assets.ts` 首次使用时解包到沙箱，之后按请求路径直读。
//
// 用法：node scripts/sync-builtin.mjs [dist目录] [插件client.js]
//   dist 缺省取桌面包里那份 staged 产物（与桌面**同一 pin**，这样两端构建标识天然对齐）。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');

const dist = process.argv[2] ?? join(repoRoot, 'desktop/src-tauri/resources/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist');
const plugin = process.argv[3] ?? join(repoRoot, 'mobile/dsh-mobile-nav/lib/client.js');
const outDir = join(appRoot, 'assets');
const outFile = join(outDir, 'dsh-frontend.tgz');

/** 递归列出目录下的相对路径（**构建期**枚举一次即可，运行时不依赖清单）。 */
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

/** 造一个最小 ustar 归档（512 对齐 + 结尾两个零块）；解包在 utils 侧用 fflate。 */
function makeTar(files) {
  const blocks = [];
  for (const [name, bytes] of files) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(name).subarray(0, 100), 0);
    header.set(new TextEncoder().encode('0000644\0'), 100);
    header.set(new TextEncoder().encode('0000000\0'), 108);
    header.set(new TextEncoder().encode('0000000\0'), 116);
    header.set(new TextEncoder().encode(`${bytes.length.toString(8).padStart(11, '0')}\0`), 124);
    header.set(new TextEncoder().encode('00000000000\0'), 136);
    header[156] = '0'.charCodeAt(0);
    header.set(new TextEncoder().encode('ustar\0'), 257);
    header.set(new TextEncoder().encode('00'), 263);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    header.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes, 0);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

const indexPath = join(dist, 'index.html');
let indexHtml;
try {
  indexHtml = readFileSync(indexPath, 'utf8');
} catch {
  console.error(`找不到内置前端 dist：${indexPath}\n  先跑 node desktop/scripts/prepare-builtin-runtime.mjs`);
  process.exit(1);
}
const m = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(indexHtml);
const entry = m ? m[1].split('?')[0].split('/').pop() : '';
if (!entry || !entry.startsWith('index-')) {
  console.error('从 index.html 认不出入口产物（形状变了？）');
  process.exit(1);
}

const files = [];
for (const rel of walk(dist)) files.push([`dsh-frontend/${rel}`, readFileSync(join(dist, rel))]);
try {
  files.push(['plugins/dsh-web-mobile/client.js', readFileSync(plugin)]);
} catch {
  console.warn(`WARN: 没有布局插件产物（${plugin}）——手机端将不注入移动布局`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, gzipSync(makeTar(files), { level: 6 }));
console.log(`已打包 ${files.length} 个文件 → ${relative(appRoot, outFile)}（入口 ${entry}，${(statSync(outFile).size / 1048576).toFixed(1)} MB）`);
