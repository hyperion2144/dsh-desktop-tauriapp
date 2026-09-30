// 随包运行时整包的**格式与拆包**（#155）：纯逻辑、无原生依赖，因此能在 node 里单测。
//
// 为什么要单独一层：`builtin-assets.ts` 要碰 expo-asset / expo-file-system（原生模块，node 里加载不了），
// 而"整包长什么样、怎么拆出 dist 与布局插件"这件事与平台无关——放这里既能被 vitest 锁住，
// 也让两端（Expo / 鸿蒙）的包格式契约有唯一落点。
import { gunzipSync } from 'fflate';
import { entryName } from '../../../shell-web/local-assets.mjs';
import { parseTar, type FrontendDist } from './frontend-assets';

/** 包内布局插件的路径前缀（与 scripts/sync-builtin.mjs 的写入路径一致）。 */
export const PLUGIN_PREFIX = 'plugins/dsh-web-mobile/';
/** 包内前端产物的路径前缀。 */
export const DIST_PREFIX = 'dsh-frontend/';

export interface BuiltinAssets {
  /** 可直接当「本地产物」用的 dist（相对路径 → 字节）。 */
  dist: FrontendDist;
  /** 随包布局插件的 client.js 内容（Host 没装它时唯一来源）。 */
  pluginClientJs: string;
}

/**
 * 拆随包整包（gzip + tar）。
 *
 * 返回 null 的三种情形都**明确**：不是 gzip、没有 `index.html`、或者从 index.html 认不出入口产物
 * （等于"这份包不是前端产物"）。调用方据此安静地退回「下载对应运行时」，而不是拿半个包去起服务。
 */
export function splitBundle(tgz: Uint8Array): BuiltinAssets | null {
  let raw: Uint8Array;
  try {
    raw = gunzipSync(tgz);
  } catch {
    return null;
  }
  const files = new Map<string, Uint8Array>();
  let pluginClientJs = '';
  for (const e of parseTar(raw)) {
    if (e.name.startsWith(DIST_PREFIX)) {
      const rel = e.name.slice(DIST_PREFIX.length);
      if (rel !== '' && !rel.endsWith('/')) files.set(rel, e.bytes);
      continue;
    }
    if (e.name.startsWith(PLUGIN_PREFIX) && e.name.endsWith('client.js')) {
      pluginClientJs = new TextDecoder().decode(e.bytes);
    }
  }
  const indexHtml = files.get('index.html');
  if (!indexHtml) return null;
  const entry = entryName(new TextDecoder().decode(indexHtml));
  if (!entry) return null;
  // 版本标识就用包内 index.html 认出来的入口产物名——与远端比的就是它（与桌面/鸿蒙同一把尺子）。
  return { dist: { version: entry, entry, files }, pluginClientJs };
}
