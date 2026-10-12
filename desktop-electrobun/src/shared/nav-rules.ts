// D1：主窗导航守卫（旧壳 on_navigation 的 Electrobun 等价物）。
// Electrobun 的导航裁决在原生层同步评估（不回调 Bun）：规则是 glob 串数组，
// `^` 前缀 = 阻断规则；「最后命中的规则赢」；都不命中默认放行。
// 语义见 electrobun package/src/native/shared/navigation_rules.h（本仓未 vendored，
// schema 以其发布 API setNavigationRules(rules: string[]) 为准）。

export interface NavRulesInput {
  /** 页面 origin（http://127.0.0.1:<port>，远程模式是远程 origin） */
  origin: string
  /** 允许其它 host（外部 dsh 场景下 pageUrl 也可能不是本壳 origin） */
  extraOrigins?: readonly string[]
}

/** origin → glob 串（大小写不敏感匹配，故无需小写化；`*` 跨段） */
export function navRulesFor({ origin, extraOrigins = [] }: NavRulesInput): string[] {
  const allowOrigins = [origin, ...extraOrigins].filter((entry) => entry !== '')
  // 收尾阻断一切非白名单导航。注意「最后命中的规则赢」：阻断规则 '^*' 必须放在最前，
  // 白名单在后——白名单 URL 先命中阻断再命中 allow，最终放行；站外只命中阻断，被拦。
  const rules: string[] = ['^*']
  for (const entry of allowOrigins) rules.push(`${entry}/*`)
  return rules
}
