// React 薄壳（#155）：把会话控制器的快照接进组件生命周期。
//
// 这里**刻意不做状态决策**——状态机全在 remote-controller.ts（node 里可测）。本文件只做三件事：
// 建控制器、订阅快照、需要时自动开跑。
import { useEffect, useMemo, useState } from 'react';
import { createSessionController, type SessionController, type SessionState } from './remote-controller';
import type { RemoteSessionPorts } from './remote-session';

export interface UseRemoteSessionResult {
  controller: SessionController | null;
  state: SessionState | null;
}

/**
 * @param ports 端口（null = 还没准备好，例如 dist 缓存尚未读出来；此时不启动）
 * @param fallbackUrl 回退时用的远端地址
 * @param autoStart 挂载即开跑（缺省 true）
 */
export function useRemoteSession(opts: {
  ports: RemoteSessionPorts | null;
  fallbackUrl: string;
  autoStart?: boolean;
}): UseRemoteSessionResult {
  const { ports, fallbackUrl, autoStart = true } = opts;
  // 端口对象变了（换了远端/换了缓存）就重建控制器：状态机的输入变了，旧状态没有意义。
  const controller = useMemo(
    () => (ports ? createSessionController({ ports, fallbackUrl }) : null),
    [ports, fallbackUrl],
  );
  const [state, setState] = useState<SessionState | null>(controller?.getState() ?? null);

  useEffect(() => {
    if (!controller) {
      setState(null);
      return;
    }
    setState(controller.getState());
    const off = controller.subscribe(setState);
    if (autoStart) void controller.start();
    return off;
  }, [controller, autoStart]);

  return { controller, state };
}
