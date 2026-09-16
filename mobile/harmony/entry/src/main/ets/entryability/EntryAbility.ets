import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BackgroundKeeper } from '../common/BackgroundKeeper';
import { NetworkWatcher } from '../common/NetworkWatcher';
import { SessionGuard } from '../common/SessionGuard';
import { window } from '@kit.ArkUI';

const DOMAIN = 0x0001;
const TAG = 'EntryAbility';

export default class EntryAbility extends UIAbility {
  private backgroundKeeper: BackgroundKeeper = new BackgroundKeeper();
  private networkWatcher: NetworkWatcher = new NetworkWatcher();

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
    const uri = (want?.uri ?? '')
      || (typeof want?.parameters?.uri === 'string' ? want.parameters.uri : '');
    AppStorage.setOrCreate<string>('pairDeepLink', uri);
    // 网络换代监听是进程级事实，不随页面启停：Wi-Fi ↔ 蜂窝 / 断网恢复时，
    // ArkWeb 不会自己把旧链路上的 WebSocket 迁走（#67 任务 2）。
    this.networkWatcher.start();
  }

  /** 退后台：立刻申请长时任务，尽量不让进程被挂起（#67 任务 1）。 */
  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
    SessionGuard.get().markBackground();
    // 申请可能被系统拒（模式白名单 / 权限）：拒绝后自动回落到回前台自愈路径。
    this.backgroundKeeper.request(this.context).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, 'background task request failed: %{public}s',
        e?.message ?? String(e));
    });
  }

  /** 回前台：释放长时任务，并做一次会话自愈（#67 任务 4）。 */
  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
    this.backgroundKeeper.release(this.context).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, 'background task release failed: %{public}s',
        e?.message ?? String(e));
    });
    SessionGuard.get().onForeground().catch((e: Error) => {
      hilog.error(DOMAIN, TAG, 'session self-heal failed: %{public}s', e?.message ?? String(e));
    });
  }

  /** 进程退出：停网络监听（NetConnection 无注销接口，置空引用即可）。 */
  onDestroy(): void {
    this.networkWatcher.stop();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.getMainWindow().then((win) => {
      // 目标：保留顶部状态栏（内容从它下方开始），去掉底部导航栏白边。
      //
      // 方案（可靠组合，实测有效）：
      //  1. 隐藏底部导航栏：setWindowSystemBarEnable(['status']) 只留顶部状态栏，
      //     底部导航栏（含手势条区域）不再占位。
      //  2. 不用 setWindowLayoutFullScreen(true)（那会让内容全屏高度被顶部状态栏
      //     盖住）——隐藏导航栏本身已经让内容自然延伸到屏幕底部。
      //  3. 状态栏染成壳背景色 + 白字（深色主题一致）。
      //
      // 若某些设备隐藏导航栏后底部仍有安全区白边，页面里用
      // expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM]) 兜底延伸。
      win.setWindowSystemBarEnable(['status']);
      win.setWindowSystemBarProperties({
        statusBarColor: '#f5f5f7',
        statusBarContentColor: '#1d1d1f',
      });
    }).catch((e: Error) => {
      hilog.warn(DOMAIN, TAG, 'set system bar failed: %{public}s', e?.message ?? String(e));
    });

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }
}
