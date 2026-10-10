/**
 * #212：内嵌插件缺失的「可见」健康信号（纯函数，无 DOM 依赖，便于 test-client 覆盖）。
 *
 * 壳在挂共享模块池时若定位不到某个内嵌插件（安装包不完整、子模块没 checkout、上游包被
 * staged 失败等），过去只在日志里留一条 WARN —— 用户看到的是「功能悄悄没了」。这里把壳
 * 通过 `get_dsh_status` 送来的缺件清单收敛成状态条能直接渲染的文案与颜色。
 *
 * 契约：`get_dsh_status` 返回 `plugin_warnings: string[]`（空数组 = 一切正常）。
 * 壳侧写入点见 `desktop/src-tauri/src/process/plugin.rs:report_plugin_health`。
 */

/** 缺件告警色：橙（应用可用，只是少了插件）——与红色「服务异常/下线」区分开。 */
export const PLUGIN_WARNING_COLOR = '#f59e0b'

/**
 * 从 `get_dsh_status` 的返回值里取出缺件清单。
 * 脏数据（缺字段、非数组、混入非字符串）一律当「无告警」处理，绝不因为状态查询把状态条搞崩。
 */
export function readPluginWarnings(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return []
  const raw = (payload as { plugin_warnings?: unknown }).plugin_warnings
  if (!Array.isArray(raw)) return []
  return raw.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
}

/** 状态条文案；无告警回空串（调用方据此回落到生命周期文案）。 */
export function pluginWarningLabel(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return `插件缺失：${warnings.join('、')}`
}

/** 悬停说明：连同「怎么修」一起给（措辞与壳日志、票面一致）。 */
export function pluginWarningTitle(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return `内嵌插件未挂载：${warnings.join('、')}（安装包可能不完整，重装或更新本应用可修复）`
}

/**
 * 服务异常/下线（壳的 `STATUS_*` 5/6）：这两个状态下「服务怎么了」比「插件缺失」更要紧，
 * 缺件只做附加说明，不能整体顶替（否则用户看不到服务已经下线）。
 * 数值口径与 `desktop/src-tauri/src/runtime/state.rs` 的 `STATUS_*` 常量一致。
 */
export const CRITICAL_STATUSES: readonly number[] = [5, 6]

/** 该生命周期状态是否属于「必须原样显示」的严重态。 */
export function isCriticalStatus(status: number): boolean {
  return CRITICAL_STATUSES.includes(status)
}

/**
 * 合成状态条文案：
 * - 无告警 → 原样返回生命周期文案；
 * - 严重态（服务异常/下线）→ `服务异常（插件缺失：X）`，两个信息都在；
 * - 其它状态（准备中/就绪）→ 缺件告警优先（壳「就绪」但插件没挂上，用户只有这里能知道）。
 */
export function composeStatusLabel(status: number, lifecycleLabel: string, warnings: string[]): string {
  const warn = pluginWarningLabel(warnings)
  if (warn === '') return lifecycleLabel
  return isCriticalStatus(status) ? `${lifecycleLabel}（${warn}）` : warn
}
