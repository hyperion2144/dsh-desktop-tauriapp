// 系统语言：壳要知道它，页面才知道该用哪种语言渲染。
//
// 为什么不能直接问 `Intl`：Bun 从终端启动时 `Intl.DateTimeFormat().resolvedOptions().locale`
// 给的是 ICU 默认值（本机实测 en-US），不是 macOS 用户的 AppleLocale（实测 zh_CN）。
// 旧壳是 WKWebView，`navigator.language` 天然跟随系统；换到 CEF 后这个信息得由壳自己带进去。
//
// 取值顺序：LC_ALL / LC_MESSAGES / LANG（非 C/ POSIX）> macOS `defaults read -g AppleLocale`
// > Intl > en-US。

export const FALLBACK_LOCALE = 'en-US'

/** 把 `zh_CN` / `zh-Hans_CN.UTF-8@modifier` 这类写法归一成 BCP-47（`zh-CN`）。 */
export function normalizeLocale(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'C' || trimmed === 'POSIX') return null
  const withoutModifier = trimmed.split('@')[0] ?? ''
  const withoutCodeset = withoutModifier.split('.')[0] ?? ''
  const parts = withoutCodeset.replace(/_/g, '-').split('-').filter((part) => part !== '')
  if (parts.length === 0) return null
  const [language, ...rest] = parts
  if (language === undefined || !/^[A-Za-z]{2,3}$/.test(language)) return null
  const normalized = [language.toLowerCase()]
  for (const part of rest) {
    normalized.push(part.length === 2 ? part.toUpperCase() : part.length === 4 ? `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}` : part)
  }
  return normalized.join('-')
}

/** 页面上 `navigator.languages` 用的候选表：主语言、其基语言、en-US。 */
export function localeCandidates(locale: string): string[] {
  const base = locale.split('-')[0] ?? locale
  return [...new Set([locale, base, FALLBACK_LOCALE, 'en'])]
}

export async function systemLocale(env: Record<string, string | undefined> = process.env): Promise<string> {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[key]
    if (value !== undefined && value !== '') {
      const normalized = normalizeLocale(value)
      if (normalized !== null) return normalized
    }
  }
  if (process.platform === 'darwin') {
    try {
      const proc = Bun.spawnSync(['defaults', 'read', '-g', 'AppleLocale'])
      if (proc.exitCode === 0) {
        const normalized = normalizeLocale(proc.stdout.toString())
        if (normalized !== null) return normalized
      }
    } catch {}
  }
  const intl = normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  return intl ?? FALLBACK_LOCALE
}
