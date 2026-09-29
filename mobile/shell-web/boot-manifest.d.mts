// `mobile/shell-web/boot-manifest.mjs` 的类型声明（#155）。见同目录 local-assets.d.mts 的说明。

export interface BootEntry {
  id: string;
  url: string;
  rev: string;
  inject?: string[];
  external?: string[];
  immediately?: boolean;
}

export interface BootBatch {
  phase: 'bootstrap' | 'application';
  url: string;
  rev: string;
  entries: string[];
}

export interface BootGraph {
  rev?: string;
  entries: BootEntry[];
  batches: BootBatch[];
  [k: string]: unknown;
}

export interface LocalPluginDescriptor {
  id: string;
  url: string;
  rev: string;
  inject?: string[];
  immediately?: boolean;
}

/** 需要剥掉的 lane 页面补丁标记（与桌面 `scheme.rs::drop_lane_patches` 同一清单）。 */
export declare const LANE_PATCH_MARKERS: string[];

export declare function stripLanePatches(html: string): string;

/** 取启动图对象与其在文本中的 JSON 区间。 */
export declare function readBootGraph(
  html: string,
): { graph: BootGraph; start: number; end: number } | null;

/** 增补一个随包插件（一行 entry + 独占 application batch）；已有同 id/同 url 则不动。 */
export declare function augmentBootGraph(
  graph: BootGraph | null | undefined,
  plugin: LocalPluginDescriptor,
): { graph: BootGraph | null | undefined; added: boolean; reason?: string };

export declare function writeBootGraph(
  html: string,
  located: { start: number; end: number } | null | undefined,
  graph: BootGraph,
): string;

/** 组装壳内页面：远程 HTML → 剥 lane 补丁 →（可选）增补随包插件 → 写回。 */
export declare function composeDocument(input: {
  remoteHtml: string;
  localPlugin?: LocalPluginDescriptor | null;
}): { html: string; stripped: boolean; bootAdded: boolean; bootReason?: string };
