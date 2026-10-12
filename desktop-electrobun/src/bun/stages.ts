// 启动阶段：启动界面（splash）与窗口标题用它报进度，日志也用它对齐口径。
//
// 为什么单独一个模块：它是**纯数据 + 纯函数**，缝 ② 的单测直接断言顺序与百分比，
// 主进程（index.ts）与 splash HTML 只消费它，不各自写一份文案。

export type ShellStage =
  | 'instance'
  | 'layout'
  | 'ports'
  | 'host'
  | 'cookie'
  | 'server'
  | 'ready'

export interface StageInfo {
  stage: ShellStage
  label: string
}

/** 顺序即进度：百分比按它在表里的位置算，别在别处再排一遍。 */
export const SHELL_STAGES: readonly StageInfo[] = [
  { stage: 'instance', label: '检查已有实例' },
  { stage: 'layout', label: '定位运行时与前端资产' },
  { stage: 'ports', label: '认领页面端口' },
  { stage: 'host', label: '启动 dsh 宿主' },
  { stage: 'cookie', label: '建立会话（取 cookie）' },
  { stage: 'server', label: '启动本地服务面' },
  { stage: 'ready', label: '就绪' },
] as const

export const FAILED_LABEL = '启动失败'

export function stageIndex(stage: ShellStage): number {
  const found = SHELL_STAGES.findIndex((entry) => entry.stage === stage)
  return found < 0 ? 0 : found
}

export function stageLabel(stage: ShellStage): string {
  return SHELL_STAGES[stageIndex(stage)]?.label ?? stage
}

/** 0–100，按阶段在表里的位置线性给；'ready' 给 100。 */
export function stagePercent(stage: ShellStage): number {
  const total = SHELL_STAGES.length
  return Math.round(((stageIndex(stage) + 1) / total) * 100)
}
