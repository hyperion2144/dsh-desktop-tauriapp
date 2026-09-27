// 会话守卫的壳侧编排（#144）：把 src/lib/session-guard.ts 的纯判定接到 WebView 上。
//
// 三条触发路径（维护者拍板：都走「页面内轻量重连优先」）：
//   1. 回前台（AppState → active）：探针一次；
//   2. 前台可达性看门狗：定时 fetch 目标 base，失败→成功跳变视作网络换代（无 NetInfo 依赖）；
//   3. 渲染进程崩溃（onContentProcessDidTerminate / onRenderProcessGone）：页面已无法执行脚本 → 兜底重载。
// 探针读数只能经 postMessage 回读；壳侧另设超时——超时未回 = 页面读不到 = 兜底重载。

import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import {
  GUARD_PROBE_TIMEOUT_MS,
  SETTLE_AFTER_REPAIR_MS,
  actionForReading,
  backoffDelayMs,
  buildGuardProbeScript,
  buildLightReconnectScript,
  readingFromMessage,
  shouldEscalateToReload,
} from './session-guard';

/** 壳侧等待探针回传的上限：页面内超时（1.2s）之后再留一段回传余量。 */
const SHELL_PROBE_TIMEOUT_MS = GUARD_PROBE_TIMEOUT_MS + 800;
/** 前台可达性看门狗间隔（毫秒）。 */
const REACHABILITY_INTERVAL_MS = 20000;
/** 连续这么多次探针无回传才判「页面无法执行脚本」（单次先重试一次） */
const MISSED_PROBE_LIMIT = 2;

interface GuardCounters {
  failures: number;
  reconnects: number;
  reloads: number;
  lastRepairAt: number;
  probing: boolean;
  /** 连续「无回传」次数（能回消息即清零）：达到上限才判页面无法执行脚本 */
  missedProbes: number;
  reachable: boolean | null;
  probeTimer: ReturnType<typeof setTimeout> | null;
}

export interface SessionGuardHooks {
  onMessage: (event: WebViewMessageEvent) => void;
  onRenderProcessGone: () => void;
}

/**
 * 绑定会话守卫。
 *
 * @param webRef WebView 引用（reload/injectJavaScript 都经它）
 * @param base 目标 base（`host:port`），用于前台可达性看门狗
 * @param label 日志前缀（便于实机抓 log）
 */
export function useSessionGuard(
  webRef: React.RefObject<WebView | null>,
  base: string,
  label = 'session-guard',
): SessionGuardHooks {
  const c = useRef<GuardCounters>({
    failures: 0,
    reconnects: 0,
    reloads: 0,
    lastRepairAt: 0,
    probing: false,
    missedProbes: 0,
    reachable: null,
    probeTimer: null,
  });

  const settled = () => c.current.lastRepairAt > 0 && Date.now() - c.current.lastRepairAt < SETTLE_AFTER_REPAIR_MS;

  const reloadPage = useCallback(
    (reason: string) => {
      c.current.reloads += 1;
      c.current.lastRepairAt = Date.now();
      console.warn(`[${label}] 兜底重载 #${c.current.reloads} reason=${reason}`);
      webRef.current?.reload();
    },
    [label, webRef],
  );

  const reconnectInPage = useCallback(
    (reason: string) => {
      c.current.reconnects += 1;
      c.current.lastRepairAt = Date.now();
      console.warn(`[${label}] 轻量重连 #${c.current.reconnects} reason=${reason}`);
      webRef.current?.injectJavaScript(buildLightReconnectScript());
    },
    [label, webRef],
  );

  /** 探针：注入后等回传；壳侧超时未回按「页面读不到」处理。 */
  const probe = useCallback(
    (reason: string) => {
      if (settled() || c.current.probing) return;
      c.current.probing = true;
      if (c.current.probeTimer) clearTimeout(c.current.probeTimer);
      c.current.probeTimer = setTimeout(() => {
        c.current.probing = false;
        c.current.probeTimer = null;
        // 单次无回传不等于页面已死：先重试一次（大会话/长任务会让回传超出壳侧超时），
        // 连续 MISSED_PROBE_LIMIT 次无回传才判「页面无法执行脚本」→ 兜底重载。
        // 实机回归（iPad）：无此门控时每 20s 的看门狗探针偶发超时 → 周期性假刷新。
        c.current.missedProbes += 1;
        if (c.current.missedProbes < MISSED_PROBE_LIMIT) {
          console.warn(`[${label}] probe[${reason}] 无回传第 ${c.current.missedProbes} 次 → 重试`);
          probe(`${reason}:retry`);
          return;
        }
        handleReading(null, `${reason}:timeout`);
      }, SHELL_PROBE_TIMEOUT_MS);
      webRef.current?.injectJavaScript(buildGuardProbeScript());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    // handleReading 是稳定闭包（只依赖 ref），无需进依赖数组
    [webRef],
  );

  const handleReading = useCallback(
    (reading: string | null, reason: string) => {
      const action = actionForReading(reading);
      console.warn(`[${label}] probe[${reason}] reading=${reading ?? 'unreadable'} action=${action}`);
      if (action === 'none') {
        c.current.failures = 0;
        c.current.reconnects = 0;
        return;
      }
      if (action === 'wait-network') return; // 设备没网：等可达性看门狗的下一次成功跳变
      c.current.failures += 1;
      const delay = backoffDelayMs(c.current.failures);
      const since = c.current.lastRepairAt > 0 ? Date.now() - c.current.lastRepairAt : Number.MAX_SAFE_INTEGER;
      if (delay > 0 && since < delay) {
        console.warn(`[${label}] throttled: ${since}ms < backoff ${delay}ms`);
        return;
      }
      if (action === 'reload' || shouldEscalateToReload(c.current.failures, c.current.reconnects)) {
        reloadPage(reason);
        return;
      }
      reconnectInPage(reason);
    },
    [label, reconnectInPage, reloadPage],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const reading = readingFromMessage(event.nativeEvent.data);
      if (reading === null) return;
      if (c.current.probeTimer) {
        clearTimeout(c.current.probeTimer);
        c.current.probeTimer = null;
      }
      c.current.probing = false;
      c.current.missedProbes = 0; // 能回消息就说明页面活着
    },
    [handleReading],
  );

  /** 渲染进程崩溃：页面已无法执行脚本 → 直接兜底重载（仍受退避约束）。 */
  const onRenderProcessGone = useCallback(() => {
    c.current.failures += 1;
    const delay = backoffDelayMs(c.current.failures);
    const since = c.current.lastRepairAt > 0 ? Date.now() - c.current.lastRepairAt : Number.MAX_SAFE_INTEGER;
    if (delay > 0 && since < delay) return;
    reloadPage('render-crash');
  }, [reloadPage]);

  // 回前台 → 探针一次（不再整页重载）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') probe('foreground');
    });
    return () => sub.remove();
  }, [probe]);

  // 前台可达性看门狗：失败→成功跳变 = 网络换代；顺带在长期停留前台时兜一次探针
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !base) return;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      let ok = false;
      try {
        await fetch(`http://${base}/`, { method: 'HEAD', signal: ctrl.signal });
        ok = true;
      } catch {
        ok = false;
      } finally {
        clearTimeout(t);
      }
      if (cancelled) return;
      const prev = c.current.reachable;
      c.current.reachable = ok;
      if (prev === false && ok) {
        // 换代：本次不判「读不到」，先探针确认页面侧状态
        c.current.failures = 0;
        c.current.reconnects = 0;
        probe('network-switch');
      }
      // 注意：**不再**在长期停留前台时周期性探针（#144 实机：iPad 每 20s 被假重载一次）。
      // 探测只发生在「回前台」与「可达性失败→成功跳变」两个真实事件上。
    };
    const iv = setInterval(() => void tick(), REACHABILITY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [base, probe]);

  return { onMessage, onRenderProcessGone };
}
