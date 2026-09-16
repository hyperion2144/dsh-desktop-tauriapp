import { connection } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SessionGuard } from './SessionGuard';

/**
 * 网络换代监听（#67 任务 2）。
 *
 * ArkWeb 不会自行把已建立的 WebSocket 迁到新链路上：Wi-Fi ↔ 蜂窝切换、断网恢复
 * 之后，旧 TCP 链路半死，页面侧可能既收不到 `close` 也收不到 `error`（NAT 静默
 * 丢弃），于是连接永远不恢复。本模块负责把「网络换代」这件事**变成一次会话检查**。
 *
 * 两层去抖，缺一不可：
 *  - `DEBOUNCE_MS`：一次切换会连续触发多条能力变化事件（掉网 → 无 VALIDATED →
 *    新网 → VALIDATED），去抖窗口内合并为一次检查，避免把切换放大成重载风暴；
 *  - 代际号：只对「可用性真的变了」的边沿计数，重复的同态事件不重复检查。
 *
 * 监听对象是**默认网络**（不传 netSpecifier），因此需要 `GET_NETWORK_INFO` 权限。
 */

const DOMAIN = 0x0001;
const TAG = 'NetworkWatcher';

/** 能力变化去抖窗口（毫秒）：窗口内只认最后一次，合并一次切换的多条事件。 */
const DEBOUNCE_MS = 1500;

/**
 * 网络代际判定（纯函数，便于推理与真机日志对照）。
 *
 * 只看 `VALIDATED`：`INTERNET` 只说明「声明了上网能力」，门户/弱网下依然为真，
 * 而 `VALIDATED` 才代表系统确认这条链路真的能通。两态之间的**跳变**才算换代。
 */
export function nextGeneration(prevValidated: boolean, validated: boolean, generation: number): number {
  if (prevValidated === validated) return generation;
  return generation + 1;
}

/** 从能力集合里取「已被系统验证可用」。 */
export function isValidated(caps: connection.NetCapabilities): boolean {
  const list = caps.networkCap;
  if (list === undefined || list === null) return false;
  return list.indexOf(connection.NetCap.NET_CAPABILITY_VALIDATED) >= 0;
}

/**
 * 默认网络的换代监听器。
 *
 * 生命周期：`EntryAbility.onCreate` 启动（进程级，与 Ability 同寿），
 * `onDestroy` 停止。不随页面切换启停——网络事件是进程级事实。
 */
export class NetworkWatcher {
  private net: connection.NetConnection | undefined = undefined;
  private generation: number = 0;
  private validated: boolean = false;
  private debounceTimer: number = -1;
  private running: boolean = false;

  /** 开始监听。重复调用无副作用。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    // 不传 netSpecifier：关注默认网络，因此需要 GET_NETWORK_INFO 权限。
    this.net = connection.createNetConnection();
    // 注：NetConnection 只提供 on()，没有注销接口；监听随 NetConnection 对象一起
    // 被回收，stop() 只丢掉引用，因此这里必须用箭头函数（无外部 this 依赖）。
    this.net.on('netCapabilitiesChange', (info: connection.NetCapabilityInfo) => {
      try {
        const nowValidated = isValidated(info.netCap);
        const next = nextGeneration(this.validated, nowValidated, this.generation);
        hilog.info(DOMAIN, TAG, 'netCapabilitiesChange validated=%{public}s gen=%{public}d->%{public}d handle=%{public}s',
          nowValidated, this.generation, next, String(info.netHandle.netId));
        if (next === this.generation) {
          // 同态事件（比如带宽/承载类型变化）：不是换代，不触发会话检查。
          return;
        }
        this.validated = nowValidated;
        this.generation = next;
        this.schedule();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'netCapabilitiesChange handler failed: %{public}s', this.errText(e));
      }
    });
    this.net.on('netLost', (handle: connection.NetHandle) => {
      hilog.warn(DOMAIN, TAG, 'netLost handle=%{public}s', String(handle.netId));
      // 掉网本身不修（没网重载无意义），只记代际；恢复时的 VALIDATED 跳变会触发检查。
      this.validated = false;
    });
    hilog.info(DOMAIN, TAG, 'started, watching default network');
  }

  /** 停止监听并清理定时器。 */
  stop(): void {
    this.running = false;
    if (this.debounceTimer !== -1) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = -1;
    }
    // NetConnection 无 off/unregister：置空引用即可，回调不会再被驱动。
    this.net = undefined;
    hilog.info(DOMAIN, TAG, 'stopped, generation=%{public}d', this.generation);
  }

  /** 当前代际号（真机日志与调试用）。 */
  current(): number {
    return this.generation;
  }

  /** 去抖：窗口内多次换代只检查一次。 */
  private schedule(): void {
    if (this.debounceTimer !== -1) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = -1;
      // 异步检查；失败已在 SessionGuard 内部消化，这里只防未捕获拒绝。
      SessionGuard.get().onNetworkSwitch().catch((e: object) => {
        hilog.error(DOMAIN, TAG, 'session check failed: %{public}s', this.errText(e));
      });
    }, DEBOUNCE_MS);
  }

  private errText(e: object): string {
    const err = e as Error;
    return err !== undefined && err !== null && err.message !== undefined ? err.message : String(e);
  }
}
