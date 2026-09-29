// 会话控制器（#155）：把编排包成"可订阅的状态源"，React 只做一层薄封装。
//
// 为什么不直接写个 hook：hook 只能在渲染器里跑（本仓没装组件测试库），而这条链**最需要被测的
// 恰恰是状态转移**（什么时候能进页面、什么时候该弹三选一、失败往哪退）。于是状态机做成普通的
// 订阅式对象（node 里逐条测），hook 只负责把它的快照接进 React 生命周期。

import { continueRemoteSession, openRemoteSession, type GateChoice, type RemoteSessionOutcome, type RemoteSessionPorts } from './remote-session';
import type { FrontendDist } from './frontend-assets';
import type { GateResult } from '../../../shell-web/local-assets.mjs';

export type SessionPhase =
  /** 还没开始。 */
  | 'idle'
  /** 正在换会话 / 检测版本 / 下载。 */
  | 'working'
  /** 需要用户在三选一里选（本地没有匹配产物）。 */
  | 'gate'
  /** 就绪：WebView 该加载 `url`（壳内 origin，本地资产 + 远程数据）。 */
  | 'ready'
  /** 回退：直接以 URL 打开远端页面（最保守那条路）。 */
  | 'fallback'
  /** 出错（端口抛错等；不是"缺产物"）。 */
  | 'error';

export interface SessionState {
  phase: SessionPhase;
  /** 该加载的地址：`ready` = 壳内 origin；`fallback` = 远端页面。 */
  url: string | null;
  /** `gate` 阶段的闸门结论（含原因，UI 直接展示）。 */
  gate: Extract<GateResult, { kind: 'missing' } | { kind: 'unavailable' }> | null;
  /** `error` / `fallback` 的原因。 */
  reason: string | null;
  /** `ready` 时生效的产物（版本 + 入口产物名）。 */
  version: string | null;
  entry: string | null;
  /** 诊断日志（端口写进来的；真机上直接显示给用户看，省一次"要日志"）。 */
  logs: string[];
}

export interface SessionController {
  getState(): SessionState;
  /** 订阅状态变化（返回取消订阅）。 */
  subscribe(listener: (state: SessionState) => void): () => void;
  /** 开始：换会话 → 检测版本 → 命中起服务 / 缺产物进 gate。 */
  start(): Promise<SessionState>;
  /** 用户在 gate 里选完之后继续。 */
  choose(choice: GateChoice, fallbackDist?: FrontendDist | null): Promise<SessionState>;
}

const initial = (): SessionState => ({
  phase: 'idle',
  url: null,
  gate: null,
  reason: null,
  version: null,
  entry: null,
  logs: [],
});

export function createSessionController(deps: {
  ports: RemoteSessionPorts;
  /** 回退时用的远端地址（`http://<base>/`）。 */
  fallbackUrl: string;
  /** 初始状态（测试与 SSR 友好）。 */
  initial?: Partial<SessionState>;
}): SessionController {
  let state: SessionState = { ...initial(), ...(deps.initial ?? {}) };
  const listeners = new Set<(s: SessionState) => void>();

  const emit = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) {
      try {
        l(state);
      } catch {
        /* 单个订阅者出错不影响其它订阅者与状态本身 */
      }
    }
    return state;
  };

  // 端口的日志进状态：真机上"看不到控制台"，这是唯一的诊断面。
  const ports: RemoteSessionPorts = {
    ...deps.ports,
    onLog: (line) => {
      emit({ logs: [...state.logs, line] });
      deps.ports.onLog?.(line);
    },
  };

  const apply = (out: RemoteSessionOutcome): SessionState => {
    if (out.kind === 'settled') {
      return emit({
        phase: 'ready',
        url: out.url,
        gate: null,
        reason: null,
        version: out.version,
        entry: out.entry,
      });
    }
    if (out.kind === 'gate-required') {
      return emit({ phase: 'gate', url: null, gate: out.gate, reason: out.gate.reason });
    }
    return emit({ phase: 'fallback', url: out.url, gate: null, reason: out.reason });
  };

  const guard = async (fn: () => Promise<RemoteSessionOutcome>): Promise<SessionState> => {
    try {
      return apply(await fn());
    } catch (e) {
      // 端口抛错（网络库异常等）：明确 error，不静默停在 working。
      return emit({ phase: 'error', url: null, gate: null, reason: `会话失败：${String(e)}` });
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      emit({ phase: 'working', reason: null, gate: null });
      return guard(() => openRemoteSession(ports));
    },
    choose(choice, fallbackDist) {
      emit({ phase: 'working', reason: null });
      return guard(() => continueRemoteSession(ports, choice, fallbackDist));
    },
  };
}
