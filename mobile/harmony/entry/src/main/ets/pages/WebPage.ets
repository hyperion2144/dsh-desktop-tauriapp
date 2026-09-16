import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Theme } from '../common/Theme';
import { PairLogic } from '../common/PairLogic';
import { SessionGuard } from '../common/SessionGuard';

/**
 * dsh 页面容器（ArkWeb）。
 *
 * #67 起本页额外承担两件事：
 *  1. 把 WebviewController 注册进 `SessionGuard`——「回前台」「网络换代」发生在
 *     EntryAbility 侧，而控制器归本页所有，注册表是两侧唯一的连接点（页面销毁即注销）；
 *  2. 渲染进程崩溃（`onRenderExited`）时重载——这是与「连接半死」不同的故障面，
 *     页面白屏时任何探针都读不到，进程内自愈不可靠时必须由壳重载。
 */

const DOMAIN = 0x0001;
const TAG = 'WebPage';

/**
 * ArkWeb socket 空闲超时（秒）。`setSocketIdleTimeout` 自 API 21 起提供，
 * 项目 compatibleSdkVersion 为 12——老设备上该静态方法不存在，调用会抛
 * BusinessError，因此必须 try/catch 降级（不能因为一个可选优化让页面起不来）。
 *
 * 取值理由：dsh mux 服务端每 2s ping，正常连接永不空闲；默认 5 分钟的空闲回收
 * 只在链路已半死（ping 收不到 pong）时才可能触发，缩短它能让坏 socket 更早被
 * 引擎丢掉，减少「句柄还在、链路已死」的窗口。最小允许 30s。
 */
const WS_IDLE_TIMEOUT_S = 30;

@Entry
@Component
struct WebPage {
  @State base: string = '';
  @State url: string = 'about:blank';
  private controller: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    const params = (router.getParams() ?? {}) as Record<string, string>;
    this.base = params['base'] ?? '';
    this.url = params['url'] ?? PairLogic.buildEnterUrl(this.base);
    // 注册控制器：EntryAbility / NetworkWatcher 侧的会话检查靠它找到页面。
    SessionGuard.get().attach(this.controller);
    this.tuneSocketIdleTimeout();
  }

  aboutToDisappear(): void {
    // 页面离开即注销，避免修复动作打到已销毁的控制器上。
    const guard = SessionGuard.get();
    if (guard !== undefined) {
      guard.attach(undefined);
    }
  }

  build() {
    Column() {
      // 无顶部栏：系统左缘右滑返回手势直接回上一页（router 栈默认支持）。
      Web({ src: this.url, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .onlineImageAccess(true)
        .onErrorReceive((event) => {
          // 只处理主 frame 错误；子资源（图片 / XHR / WS / 预加载）失败也会触发
          // onErrorReceive，但页面本身正常渲染时不应弹错误提示——刷新时误报
          // ERR_FAILED 就是子资源失败触发的（用户反馈：黑底红字但页面正常）。
          if (event?.request?.isMainFrame?.() === false) return;
          console.error('[dsh-mobile] main frame load error: ' +
            (event?.error?.getErrorInfo?.() ?? String(event?.error?.getErrorCode?.() ?? '')));
        })
        .onRenderExited((event) => {
          // 渲染进程崩溃：页面白屏，探针读不到任何东西。这里记录原因，重载交给
          // SessionGuard（它带去抖与退避，避免崩溃循环变成重载风暴）。
          hilog.error(DOMAIN, TAG, 'render exited: reason=%{public}s',
            String(event?.renderExitReason ?? 'unknown'));
          SessionGuard.get().onRenderCrash();
        })
        .onConsole((event) => {
          // #35 诊断：把 dsh 页面内 console 转发到 hilog，用 hdc hilog 抓取壳内客户端的连接日志
          console.info('[dsh-web][' + (event?.message?.getMessageLevel?.() ?? '') + '] ' + (event?.message?.getMessage?.() ?? ''));
          return false;
        })
        .layoutWeight(1)
        // 关键：让 Web 组件自身延伸到底部安全区（home indicator 之下），
        // 而不是根 Column 的背景色兜底——否则 webview 底部会留一条黑/背景色带。
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Theme.Bg)
  }

  /** 尽量缩短引擎侧 socket 空闲回收窗口；API < 21 静默降级。 */
  private tuneSocketIdleTimeout(): void {
    try {
      webview.WebviewController.setSocketIdleTimeout(WS_IDLE_TIMEOUT_S);
    } catch (e) {
      const err = e as Error;
      hilog.info(DOMAIN, TAG, 'setSocketIdleTimeout unavailable (API<21?), skipped: %{public}s',
        err !== undefined && err !== null && err.message !== undefined ? err.message : String(e));
    }
  }
}
