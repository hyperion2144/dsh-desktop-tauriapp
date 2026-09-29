// `mobile/shell-web/local-assets.mjs` 的类型声明（#155）。
//
// 为什么用 `.d.mts` 而不是给 expo-app 配路径别名：TS 对 `x.mjs` 的导入天然会去找同目录的
// `x.d.mts`，于是两端共用同一份实现（单一事实源），既不用别名也不用把逻辑抄第二遍。

export type PlatformId =
  | 'ios' | 'ipados' | 'macos' | 'android' | 'harmony'
  | 'windows' | 'linux' | 'chromeos' | 'shell' | 'browser' | 'unknown';

export interface LocalDist {
  /** 运行时/产物标识（版本或自定名）。 */
  id: string;
  /** 入口产物名（`index-<hash>.js`）——版本闸门比的就是它。 */
  entry: string;
}

export type GateResult =
  | { kind: 'matched'; dist: LocalDist }
  | { kind: 'missing'; remoteEntry: string; reason: string }
  | { kind: 'unavailable'; reason: string };

export type RouteResult =

  | { kind: 'local'; path: string }
  | { kind: 'plugin'; id: string; rest: string }
  | { kind: 'unknownPlugin'; id: string }
  | { kind: 'forward' };

export declare const FRONTEND_PACKAGE: string;
export declare const NPM_REGISTRY: string;
export declare const LOCAL_PLUGIN_PREFIX: string;
export declare const GATE_CHOICES: Array<{ id: 'download' | 'useLocal' | 'remoteWebview'; label: string; hint: string }>;

export declare function mimeOf(path: string): string;
export declare function entryName(html: string): string | null;
export declare function buildGate(input: { remoteEntry?: string | null; localDists?: LocalDist[] }): GateResult;
export declare function routeRequest(
  target: string,
  index?: { distFiles?: Set<string> | string[]; localPlugins?: string[] },
): RouteResult;
