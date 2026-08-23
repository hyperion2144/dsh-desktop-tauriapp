import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0x0001;
const TAG = 'EntryAbility';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
    const uri = (want?.uri ?? '')
      || (typeof want?.parameters?.uri === 'string' ? want.parameters.uri : '');
    AppStorage.setOrCreate<string>('pairDeepLink', uri);
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
