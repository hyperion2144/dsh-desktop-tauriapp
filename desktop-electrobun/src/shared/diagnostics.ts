/**
 * 诊断快照（纯逻辑：拼一个稳定形状的对象，IO 在 `src/bun/diagnostics.ts`）。
 *
 * 目的：用户报问题时不靠 GUI 开发者工具——一个 JSON 里能回答「哪个版本、哪个 profile、
 * 端口是多少、宿主 pid、注入几条、设置改过哪些、日志在哪、日志尾巴是什么」。
 * 旧壳没有这个面（只有 tauri-plugin-log 的原始日志文件），这里是 #220「日志与诊断」补的。
 *
 * 形状约定：段名固定（shell/dsh/system/settings/views/downloads/notify/logs），字段顺序固定，
 * 便于人读、也便于 diff 两次快照。
 */

export interface DiagnosticsLogFile {
  path: string
  bytes: number
  rotated: number
}

export interface DiagnosticsInput {
  appVersion: string
  pid: number
  startedAt: string
  uptimeMs: number
  noWindow: boolean
  locale: string
  profile: string
  origin: string
  pageUrl: string
  pagePort: number
  upstreamPort: number
  lanePort: number
  hostPid: number
  hostRunning: boolean
  runtimeKind: string
  runtimeVersion: string | null
  runtimeDir: string
  distDir: string
  injections: number
  settingsSummary: string
  settingsPath: string
  settingsProvenance: { created: boolean; migrated: boolean; recovered: boolean }
  views: { kind: string; profile: string; label: string }[]
  downloads: { tasks: number; active: number; concurrency: number }
  notify: { available: boolean; permission: string; port: number }
  logs: { shell: DiagnosticsLogFile; webview: DiagnosticsLogFile; tail: string[] }
  process: { platform: string; arch: string; osRelease: string; bun: string; node?: string; cpus: number; totalMemBytes: number; freeMemBytes: number }
}

/** 快照里日志尾巴保留多少行。 */
export const DIAG_TAIL_LINES = 80

export function buildDiagnostics(input: DiagnosticsInput, now: Date): Record<string, unknown> {
  return {
    generatedAt: now.toISOString(),
    // 一行摘要：面板/日志里直接显示，不用自己拼字段
    summary: diagnosticsSummary(input),
    shell: {
      appVersion: input.appVersion,
      pid: input.pid,
      startedAt: input.startedAt,
      uptimeMs: input.uptimeMs,
      noWindow: input.noWindow,
      locale: input.locale,
    },
    dsh: {
      profile: input.profile,
      origin: input.origin,
      pageUrl: input.pageUrl,
      pagePort: input.pagePort,
      upstreamPort: input.upstreamPort,
      lanePort: input.lanePort,
      hostPid: input.hostPid,
      hostRunning: input.hostRunning,
      runtimeKind: input.runtimeKind,
      runtimeVersion: input.runtimeVersion,
      runtimeDir: input.runtimeDir,
      distDir: input.distDir,
      injections: input.injections,
    },
    settings: {
      path: input.settingsPath,
      summary: input.settingsSummary,
      provenance: input.settingsProvenance,
    },
    views: input.views,
    downloads: input.downloads,
    notify: input.notify,
    logs: {
      shell: input.logs.shell,
      webview: input.logs.webview,
      tail: input.logs.tail,
    },
    process: {
      platform: input.process.platform,
      arch: input.process.arch,
      osRelease: input.process.osRelease,
      bun: input.process.bun,
      ...(input.process.node === undefined ? {} : { node: input.process.node }),
      cpus: input.process.cpus,
      totalMemBytes: input.process.totalMemBytes,
      freeMemBytes: input.process.freeMemBytes,
    },
  }
}

/** 导出文件名：`diag-YYYYMMDD-HHmmss.json`（本地时区，与日志时间戳一致）。 */
export function diagnosticsFileName(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `diag-${date}-${time}.json`
}

/** 给人看的一行摘要（RPC 返回值里带上，便于面板直接显示）。 */
export function diagnosticsSummary(input: DiagnosticsInput): string {
  const version = input.runtimeVersion ?? '未知'
  return `${input.profile} · ${input.runtimeKind} ${version} · 页面 ${String(input.pagePort)} / 上游 ${String(input.upstreamPort)} · 宿主 ${String(input.hostPid)}`
}
