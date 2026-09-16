import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { buildGuardProbeScript, parseGuardProbeResult } from './GuardScript';

/**
 * 壳侧会话修复器（#67）。
 *
 * 背景：dsh 页面的 `/api/remote.mux` WebSocket 由页面 JS 在 ArkWeb 内部创建，
 * 壳的 native 层拿不到句柄；而 dsh 客户端只在 `close`/`error` 事件到达时才重连
 * （`dsh-api-gateway/lib/client.js` 的 `lost()` → `maintain()`）。退后台时进程被
 * 挂起、回到前台后连接已被服务端判死（dsh mux 服务端 2s ping + 连丢 2 次即
 * `terminate()`），但页面不一定收到 `close`——这就是「回前台不自愈」的根因。
 *
 * 本模块只做**判定与修复**，不碰配对与鉴权（那是页面的职责）：
 *  - 输入：两类「链路可能已换代」的事件（回前台、网络切换）
 *  - 眼睛：`runJavaScript` 注入探针，问页面「你还连得上吗」
 *  - 手：`controller.refresh()`——ArkWeb 内没有比重载更可靠的复位手段
 *  - 闸：失败计数 + 指数退避，避免「重载 → 仍失败 → 立刻再重载」的风暴
 *
 * 探针读数与页面脚本的契约见 `GuardScript.ets`。
 */

const DOMAIN = 0x0001;
const TAG = 'SessionGuard';

/** 修复判定原因（写进日志，真机用 hdc hilog 抓取）。 */
export enum RepairReason {
  /** 回前台，后台停留超过阈值，连接大概率已被服务端判死 */
  FOREGROUND_AFTER_SUSPEND = 'fg-suspend',
  /** 回前台，后台时间很短，仍探针确认 */
  FOREGROUND = 'fg',
  /** 网络换代（Wi-Fi ↔ 蜂窝、断网恢复） */
  NETWORK_SWITCH = 'net-switch',
  /** 渲染进程崩溃（白屏） */
  RENDER_CRASH = 'render-crash'
}


/** 健康/修复状态，供真机日志与后续 UI 状态条使用。 */
export interface GuardState {
  /** 是否有页面已注册（WebPage 在 aboutToAppear 里注册） */
  attached: boolean;
  /** 连续失败次数（一次成功探针清零） */
  failures: number;
  /** 最近一次探针读数（`信号|在线|套接字`） */
  lastReading: string;
  /** 最近一次修复动作（空串表示没动过手） */
  lastRepair: string;
  /** 已发生的重载总次数 */
  reloadCount: number;
}

/** 修复动作判定结果，便于单元推理。 */
export enum RepairAction {
  /** 不动手 */
  NONE = 'none',
  /** 重载页面 */
  RELOAD = 'reload',
  /** 页面没网，等网络恢复事件 */
  WAIT_NETWORK = 'wait-network',
  /** 退避期内，跳过本次 */
  THROTTLED = 'throttled'
}

/** 连续失败第几次开始退避（前几次直接修，避免把偶发超时拖成慢性病）。 */
const BACKOFF_AFTER_FAILURES = 2;
/** 退避步长基数（毫秒）：第 n 次失败等待 `BASE * 2^(n-2)`。 */
const BACKOFF_BASE_MS = 2000;
/** 退避上限（毫秒）。 */
const BACKOFF_CAP_MS = 30000;
/** 后台停留超过该时长即认为连接已被服务端判死，直接重载、不浪费一次探针。 */
const SUSPEND_RELOAD_AFTER_MS = 10000;
/**
 * 重载后的静默期（毫秒）：页面重载本身需要时间。
 *
 * 少了这道闸会出「刚修好又判它坏」：重载后的前几秒页面还没加载完，探针读到尚未
 * 起来的客户端（ds0）就会再次重载——修一次变修两次。静默期内所有检查直接跳过。
 */
const SETTLE_AFTER_RELOAD_MS = 5000;
/** `about:blank`：尚未导航到真实页面，重载无意义。 */
const BLANK_URL = 'about:blank';
/** 计算第 `failures` 次连续失败后的退避时长（毫秒）。 */
export function backoffDelayMs(failures: number): number {
  if (failures < BACKOFF_AFTER_FAILURES) return 0;
  const step = failures - BACKOFF_AFTER_FAILURES;
  const raw = BACKOFF_BASE_MS * Math.pow(2, step);
  return raw > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : raw;
}

/** 判定探针读数对应的动作（不变量：读不到 = 需要重载）。 */
export function actionForReading(reading: string | null): RepairAction {
  if (reading === null) return RepairAction.RELOAD;
  const signal = reading.split('|')[0];
  if (signal === 'ds') return RepairAction.NONE;
  if (signal === 'off') return RepairAction.WAIT_NETWORK;
  return RepairAction.RELOAD;
}

/**
 * 会话修复器单例。
 *
 * 为什么是单例：ArkWeb 的控制器归 `WebPage` 所有，而「回前台」「网络切换」这类
 * 事件归 `EntryAbility` / 连接管理监听器所有，两侧唯一的共同点是进程内的壳。
 * 用注册表把控制器交给事件侧，比让 Ability 去反查 UI 树可靠得多。
 */
export class SessionGuard {
  private static instance: SessionGuard | undefined = undefined;
  private controller: webview.WebviewController | undefined = undefined;
  private failures: number = 0;
  private lastReading: string = '';
  private lastRepair: string = '';
  private reloadCount: number = 0;
  private lastRepairAt: number = 0;
  /** 后台时刻（`onBackground` 打点），用于判定「挂起多久」。 */
  private backgroundAt: number = 0;
  /** 防止并发探针（探针是异步的，回前台与网络事件可能同时触发）。 */
  private probing: boolean = false;

  static get(): SessionGuard {
    if (SessionGuard.instance === undefined) {
      SessionGuard.instance = new SessionGuard();
    }
    return SessionGuard.instance;
  }

  /** WebPage 挂载时注册控制器；页面销毁时传 undefined 注销。 */
  attach(controller: webview.WebviewController | undefined): void {
    this.controller = controller;
    if (controller === undefined) {
      this.failures = 0;
      this.lastReading = '';
    } else {
      hilog.info(DOMAIN, TAG, 'attached page: %{public}s', this.safeUrl(controller));
    }
  }

  /** `onBackground` 打点。 */
  markBackground(): void {
    this.backgroundAt = Date.now();
  }

  /** 当前状态快照（只读，供日志/UI）。 */
  state(): GuardState {
    return {
      attached: this.controller !== undefined,
      failures: this.failures,
      lastReading: this.lastReading,
      lastRepair: this.lastRepair,
      reloadCount: this.reloadCount
    } as GuardState;
  }

  /**
   * 回前台：超过挂起阈值直接重载；否则探针确认。
   *
   * 直接重载的取舍：离开 10s 以上时进程几乎必然被挂起，服务端已经判死连接，
   * 此时探针在挂起恢复初期并不可靠，与其等一次可能误判的探针，不如直接重载。
   * 重载会丢页面内未提交状态，但 dsh 的会话状态在服务端，代价可接受。
   */
  async onForeground(): Promise<void> {
    if (this.controller === undefined) return;
    const suspended = this.backgroundAt > 0 ? Date.now() - this.backgroundAt : 0;
    this.backgroundAt = 0;
    if (suspended >= SUSPEND_RELOAD_AFTER_MS) {
      // 静默期同样适用于这条路径：刚重载完就退后台再回来，不应再重载一次。
      if (!this.settled()) {
        hilog.debug(DOMAIN, TAG, 'suspend reload skipped (settling after reload)');
        return;
      }
      hilog.info(DOMAIN, TAG, 'foreground after %{public}dms suspend -> reload', suspended);
      this.reload(RepairReason.FOREGROUND_AFTER_SUSPEND);
      return;
    }
    await this.checkAndRepair(RepairReason.FOREGROUND);
  }

  /** 网络换代：探针确认后决定是否重载。 */
  async onNetworkSwitch(): Promise<void> {
    await this.checkAndRepair(RepairReason.NETWORK_SWITCH);
  }

  /**
   * 渲染进程崩溃：与「连接半死」不同的故障面，但同样表现为「页面自己好不了」。
   * 直接重载，与探针结果无关；退避闸依然生效，避免崩溃循环变成重载风暴。
   */
  onRenderCrash(): void {
    if (this.controller === undefined) return;
    this.failures += 1;
    const delay = backoffDelayMs(this.failures);
    const since = this.lastRepairAt > 0 ? Date.now() - this.lastRepairAt : Number.MAX_SAFE_INTEGER;
    if (delay > 0 && since < delay) {
      hilog.warn(DOMAIN, TAG, 'render crash throttled: %{public}dms < backoff %{public}dms', since, delay);
      return;
    }
    this.reload(RepairReason.RENDER_CRASH);
  }

  /** 探针 + 判定 + 修复。 */
  private async checkAndRepair(reason: RepairReason): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) return;
    // 静默期：上一次重载还没落定，此时探针结果不可信。
    if (!this.settled()) {
      hilog.debug(DOMAIN, TAG, 'probe skipped (settling after reload): %{public}s', reason);
      return;
    }
    if (this.probing) {
      hilog.debug(DOMAIN, TAG, 'probe skipped (in flight): %{public}s', reason);
      return;
    }
    this.probing = true;
    let reading: string | null = null;
    try {
      const raw = await controller.runJavaScript(buildGuardProbeScript());
      reading = parseGuardProbeResult(raw);
    } catch (e) {
      // 注入失败（页面已销毁 / 控制器未附着）：当作「读不到」，走重载判定。
      reading = null;
      hilog.warn(DOMAIN, TAG, 'probe failed: %{public}s', this.errText(e));
    } finally {
      this.probing = false;
    }

    this.lastReading = reading === null ? 'unreadable' : reading;
    const action = actionForReading(reading);
    hilog.info(DOMAIN, TAG, 'probe[%{public}s] reading=%{public}s action=%{public}s failures=%{public}d',
      reason, this.lastReading, action, this.failures);

    if (action === RepairAction.NONE) {
      // 健康：连续失败计数清零，退避随之解除（下次异常立即修复，不拖成慢性病）。
      if (this.failures > 0) {
        hilog.info(DOMAIN, TAG, 'healthy again after %{public}d failures', this.failures);
      }
      this.failures = 0;
      return;
    }

    this.failures += 1;
    if (action === RepairAction.WAIT_NETWORK) {
      // 设备无网：重载没有意义，等 netCapabilitiesChange 恢复。
      hilog.info(DOMAIN, TAG, 'offline, wait for network (%{public}s)', reason);
      return;
    }

    const delay = backoffDelayMs(this.failures);
    const since = this.lastRepairAt > 0 ? Date.now() - this.lastRepairAt : Number.MAX_SAFE_INTEGER;
    if (delay > 0 && since < delay) {
      hilog.info(DOMAIN, TAG, 'throttled: %{public}dms < backoff %{public}dms', since, delay);
      return;
    }
    this.reload(reason);
  }

  /** 重载页面并记录。 */
  private reload(reason: RepairReason): void {
    const controller = this.controller;
    if (controller === undefined) return;
    try {
      controller.refresh();
      this.reloadCount += 1;
      this.lastRepair = reason;
      this.lastRepairAt = Date.now();
      hilog.warn(DOMAIN, TAG, 'reload #%{public}d reason=%{public}s', this.reloadCount, reason);
    } catch (e) {
      // 渲染进程崩溃后 refresh 可能失败：退到显式重载当前 URL。
      // 计数只加一次——这是同一意图的第二次尝试，不是又修了一次。
      const url = this.safeUrl(controller);
      if (url.length > 0 && url !== '(unknown)' && url !== BLANK_URL) {
        try {
          controller.loadUrl(url);
          this.reloadCount += 1;
          this.lastRepair = reason + '+loadUrl';
          this.lastRepairAt = Date.now();
          hilog.warn(DOMAIN, TAG, 'reload via loadUrl #%{public}d reason=%{public}s url=%{public}s',
            this.reloadCount, reason, url);
          return;
        } catch (e2) {
          hilog.error(DOMAIN, TAG, 'loadUrl fallback failed: %{public}s', this.errText(e2));
        }
      }
      hilog.error(DOMAIN, TAG, 'reload failed: %{public}s', this.errText(e));
    }
  }

  /** 上一次重载是否已过静默期（没重载过则视为已落定）。 */
  private settled(): boolean {
    if (this.lastRepairAt === 0) return true;
    return Date.now() - this.lastRepairAt >= SETTLE_AFTER_RELOAD_MS;
  }

  private safeUrl(controller: webview.WebviewController): string {
    try {
      return controller.getUrl();
    } catch (e) {
      return '(unknown)';
    }
  }

  private errText(e: object): string {
    const err = e as Error;
    return err !== undefined && err !== null && err.message !== undefined ? err.message : String(e);
  }
}
