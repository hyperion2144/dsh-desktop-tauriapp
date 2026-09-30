// 端口构建 hook（#155）：把 WebScreen 拿到的配对目标 + App 存储接成 `RemoteSessionPorts`。
//
// 为什么单独一个 hook：`createRemotePorts` 是异步的（要读已存的会话 cookie、可能要读磁盘缓存），
// 而 React 组件只能先渲染再拿到端口——`useRemoteSession` 的 `ports` 允许为 null 正是为此留的口子。
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createRemotePorts, type KeyValueStore } from './remote-ports';
import type { DistCache } from './dist-cache';
import type { FrontendDist } from './frontend-assets';
import type { RemoteSessionPorts } from './remote-session';

/** AsyncStorage 适配成键值存储端口（会话 cookie 与 dist 缓存的清单落点）。 */
export const appStore: KeyValueStore = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
};

export interface UseRemotePortsResult {
  ports: RemoteSessionPorts | null;
  /** 构建过程中的错误（存储读失败等）；null = 正常。 */
  error: string | null;
}

/**
 * @param base 远端 authority（`host:port`）；空 = 不构建（页面还没配对好）
 * @param entryPath 一次性入口路径（`/pair?token=…`）；没有就只做版本检测
 * @param cachedDist 已解出的本地 dist（进程内缓存）
 * @param cache 持久化缓存（有它时冷启动先读磁盘、下载后落盘）
 * @param bundledPluginSource 随包布局插件内容（Host 没装时唯一来源）
 */
export function useRemotePorts(args: {
  base: string | null;
  entryPath?: string | null;
  cachedDist?: FrontendDist | null;
  cache?: DistCache;
  bundledPluginSource?: string | null;
  pluginRev?: string;
}): UseRemotePortsResult {
  const {
    base,
    entryPath = null,
    cachedDist = null,
    cache,
    bundledPluginSource = null,
    pluginRev,
  } = args;
  const [ports, setPorts] = useState<RemoteSessionPorts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!base) {
      setPorts(null);
      setError(null);
      return () => {
        alive = false;
      };
    }
    void createRemotePorts({
      base,
      entryPath,
      store: appStore,
      cachedDist,
      cache,
      bundledPluginSource,
      pluginRev,
    })
      .then((p) => {
        if (alive) {
          setPorts(p);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setPorts(null);
          setError(`端口初始化失败：${String(e)}`);
        }
      });
    return () => {
      alive = false;
    };
  }, [base, entryPath, cachedDist, cache, bundledPluginSource, pluginRev]);

  return { ports, error };
}
