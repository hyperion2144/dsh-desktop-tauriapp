import type { ClientContext } from './ctx-types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { DesktopClientEnvironment } from './environment.ts'
import { installLocalChrome } from './local-chrome.ts'
import { installAdvancedStyles } from './styles.ts'

/**
 * 高级模式：不禁用 stock ui-layout、不接管 root、不提供 layout 服务，只在
 * 原生布局的局部注入窗口拖拽 chrome（macOS 侧栏顶部拖拽 + 折叠加宽容纳红绿灯；
 * Win/Linux 中间 header 顶部拖拽条 + 自绘窗口按钮，内容用 padding 顶下）。
 */
export function applyAdvancedShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'advanced') {
    throw new Error(`dsh-desktop-tauriapp: advanced shell received mode ${JSON.stringify(environment.mode)}`)
  }

  ctx.effect(() => {
    document.body.dataset.dshDesktopMode = 'advanced'
    document.body.dataset.dshDesktopPlatform = environment.platform
    const removeStyles = installAdvancedStyles()
    return () => {
      removeStyles()
      delete document.body.dataset.dshDesktopMode
      delete document.body.dataset.dshDesktopPlatform
    }
  }, 'desktop: advanced shell styles')

  ctx.effect(() => installLocalChrome(environment.platform), 'desktop: local window chrome')
}
