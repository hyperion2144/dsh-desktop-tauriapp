import { common, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * 后台长时任务（#67 任务 1）。
 *
 * 为什么需要：退后台后进程被系统挂起，ArkWeb 里的 WebSocket 不再回 pong；dsh mux
 * 服务端以 2s 间隔 ping、连丢 2 次即 `socket.terminate()`，因此**退后台约 6s 连接
 * 就被判死**。页面回前台时若能收到 `close` 会自行重连（`SessionGuard` 兜底不保证），
 * 但更彻底的做法是不让进程被挂起。
 *
 * 现实约束（不回避）：HarmonyOS 长时任务**会给用户挂一条常驻通知**，且系统按业务
 * 场景白名单校验 `backgroundModes` 模式；模式与业务不匹配会申请失败（错误码
 * 9800005 校验失败）。WebSocket 长连接最接近的是 `dataTransfer`，但**能否通过校验
 * 只能在真机确认**——本模块因此把「申请成功 / 被拒」都当成正常结果记录到 hilog，
 * 申请失败时自动回落到 `SessionGuard` 的回前台自愈路径，不阻断其它修复手段。
 */

const DOMAIN = 0x0001;
const TAG = 'BackgroundKeeper';

/** 连续任务模式：与 `module.json5` 的 `backgroundModes` 必须一致。 */
const BG_MODE = 'dataTransfer';

/** 长时任务保活器（进程级单例语义由 EntryAbility 保证：onBackground 申请 / onForeground 释放）。 */
export class BackgroundKeeper {
  private active: boolean = false;
  private refused: boolean = false;

  /** 当前是否持有长时任务。 */
  running(): boolean {
    return this.active;
  }

  /** 上一次申请是否被系统拒绝（真机验收要看的就是这个）。 */
  wasRefused(): boolean {
    return this.refused;
  }

  /**
   * 退后台时申请长时任务。幂等；失败只记日志，不抛。
   *
   * @param context UIAbility 的上下文
   */
  async request(context: common.UIAbilityContext): Promise<void> {
    if (this.active) return;
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [{
          bundleName: context.abilityInfo.bundleName,
          abilityName: context.abilityInfo.name
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      } as wantAgent.WantAgentInfo);
      // API 12+ 的字符串模式重载（与 module.json5 的 backgroundModes 同名）。
      await backgroundTaskManager.startBackgroundRunning(context, [BG_MODE], agent);
      this.active = true;
      this.refused = false;
      hilog.info(DOMAIN, TAG, 'continuous task started, mode=%{public}s', BG_MODE);
    } catch (e) {
      this.active = false;
      this.refused = true;
      // 真机验收关注点：201=权限未授予；9800005=模式校验失败（白名单不收）；
      // 9800006=通知校验失败。任何一种都会回落到回前台自愈路径。
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG,
        'continuous task refused (code=%{public}d msg=%{public}s) -> fallback to foreground self-heal',
        err !== undefined && err !== null && err.code !== undefined ? err.code : -1,
        err !== undefined && err !== null && err.message !== undefined ? err.message : String(e));
    }
  }

  /**
   * 回前台释放长时任务（避免常驻通知挂着不放）。幂等；失败只记日志。
   *
   * @param context UIAbility 的上下文
   */
  async release(context: common.UIAbilityContext): Promise<void> {
    if (!this.active) return;
    try {
      await backgroundTaskManager.stopBackgroundRunning(context);
      hilog.info(DOMAIN, TAG, 'continuous task stopped');
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'stop continuous task failed: %{public}s',
        err !== undefined && err !== null && err.message !== undefined ? err.message : String(e));
    } finally {
      this.active = false;
    }
  }
}
