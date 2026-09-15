// dsh 客户端上下文最小本地契约。
// dsh 0.1.5-rc.2 已移除 @deepseek-ai/dsh-client-runtime（ClientContext 类型随之消失），
// 本插件只声明实际触达的面：logger、slots、connection、sessions、theme、workspaces。
// 属性访问受 Cordis Guard 校验，必须与 index.ts 的 inject 声明保持一致。
export interface ClientLogger {
  warn?(...args: unknown[]): void
  info?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface ClientSlots {
  inject(name: string, fn: () => void): void
  register(meta: Record<string, unknown>, component: unknown): void
}

export interface ClientConnection {
  rpc: {
    call(channel: string, endpoint: string, payload?: unknown): Promise<any>
    handle(channel: string, handler: unknown, opts?: unknown): void
  }
}

export interface ClientContext {
  logger?: ClientLogger
  slots?: ClientSlots
  connection?: ClientConnection
  [key: string]: unknown
}
