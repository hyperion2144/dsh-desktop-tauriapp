// 页面桥（二）：把 `__TAURI_INTERNALS__.invoke` 接到壳的 RPC 端点上。
//
// 为什么需要：壳自己的客户端插件（`src/client/*`，随桌面壳一起发给页面的插件）全都是
// 照 Tauri 写的——`__TAURI_INTERNALS__.invoke(cmd, args)` 与 `__TAURI__.core.invoke`。
// 新壳没有 Tauri，于是 `get_desktop_client_environment` 第一次调用就落空，整片桌面 chrome
// （设置面板、通知 tab、下载 tab、本地工具栏、平台键盘…）都不激活。
//
// 这里不引入 Tauri，只提供**同名同语义**的最小实现：
//   invoke(cmd, args) → POST /__shell__/rpc {cmd,args}
//     · 200 + {ok:true, value} → resolve(value)
//     · 200 + {ok:false, error} → reject(Error(error))   ← 与 Tauri 的 reject 语义一致
//     · 其它状态码 → reject(Error('shell rpc failed: <status>'))
// 参数语义：Tauri 允许 omit args（`invoke('get_desktop_client_environment')`），这里补成 {}。

/** 壳 RPC 端点（与 `shell-server.ts` 的 `/__shell__/rpc` 一致）。 */
export const RPC_ENDPOINT = '/__shell__/rpc'

import { VIEW_TOKEN_HEADER } from '../shared/view-grant.ts'

export function tauriIpcScript(viewToken: string): string {
  return [
    'try {',
    `  const endpoint = ${JSON.stringify(RPC_ENDPOINT)}`,
    `  const viewToken = ${JSON.stringify(viewToken)}`,
    '  const invoke = (cmd, args) => {',
    '    return fetch(endpoint, {',
    "      method: 'POST',",
    `      headers: { 'content-type': 'application/json', '${VIEW_TOKEN_HEADER}': viewToken },`,
    "      cache: 'no-store',",
    '      body: JSON.stringify({ cmd: String(cmd), args: args && typeof args === \'object\' ? args : {} }),',
    '    }).then(async (res) => {',
    '      const payload = await res.json().catch(() => null)',
    "      if (res.status !== 200) throw new Error('shell rpc failed: ' + res.status)",
    '      if (payload && payload.ok === true) return payload.value',
    '      const message = payload && typeof payload.error === \'string\' ? payload.error : \'shell rpc failed\'',
    '      throw new Error(message)',
    '    })',
    '  }',
    '  Object.defineProperty(globalThis, \'__TAURI_INTERNALS__\', {',
    "    value: { invoke, transformCallback: (cb) => cb, metadata: { currentWindow: { label: 'main' } } },",
    '    configurable: true,',
    '  })',
    '  Object.defineProperty(globalThis, \'__TAURI__\', {',
    '    value: { core: { invoke } },',
    '    configurable: true,',
    '  })',
    '} catch (error) {',
    "  console.error('desktop tauri ipc shim failed', error)",
    '}',
  ].join('\n')
}
