import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Theme } from '../common/Theme';
import { PairLogic } from '../common/PairLogic';
import { SessionGuard } from '../common/SessionGuard';
import { ensureLocalAssets, entryPathOf, exchangeSession, loadCookie, readBundledPlugin } from '../common/LocalAssets';
import { LocalHost } from '../common/LocalHost';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

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
  /** 壳内 loopback 服务（#155）；未就绪时为 undefined，页面走远端地址。 */
  private localHost: LocalHost | undefined = undefined;

  aboutToAppear(): void {
    const params = (router.getParams() ?? {}) as Record<string, string>;
    this.base = params['base'] ?? '';
    this.url = params['url'] ?? PairLogic.buildEnterUrl(this.base);
    // #155：本地资产 + 远程数据（与桌面远程模式同形）。关键点：配对链接是**一次性凭据**，
    // 绝不能交给 ArkWeb 直接加载去消费——那样壳自己换不到 cookie，也无法在转发时注入。
    // 于是先把它当占位地址，同时由壳去换会话 → 装配本地产物 → 起壳内 loopback 服务，
    // 就绪后把 url 换成壳内 origin（失败则保留原地址，走「直接开远程页面」那条保守路径）。
    void this.startLocalAssets(params['url'] ?? '');
    // 注册控制器：EntryAbility / NetworkWatcher 侧的会话检查靠它找到页面。
    SessionGuard.get().attach(this.controller);
    this.tuneSocketIdleTimeout();
    // ArkWeb 性能：提前建连/预解析（#147）——首屏能省一次 DNS+TCP 往返。
    this.preconnect();
  }

  aboutToDisappear(): void {
    // 页面离开即注销，避免修复动作打到已销毁的控制器上。
    const guard = SessionGuard.get();
    if (guard !== undefined) {
      guard.attach(undefined);
    }
    // #155：同时收掉壳内 loopback 服务（否则退出页面后端口一直占着）。
    if (this.localHost !== undefined) {
      void this.localHost.stop();
      this.localHost = undefined;
    }
  }

  /**
   * 起本地资产会话：换会话（配对链接）→ 拉/命中本地产物 → 起壳内服务 → 换成壳内 origin。
   *
   * 任一步失败都回到「直接用远端地址」（最保守、永远可用）；日志进 hilog，真机上可查。
   */
  private async startLocalAssets(entryUrl: string): Promise<void> {
    if (!this.base) return;
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const entryPath = entryPathOf(entryUrl);
      let cookie = await loadCookie(context, this.base);
      if (entryPath) {
        const ex = await exchangeSession(context, this.base, entryPath);
        if (ex.ok) {
          cookie = ex.cookie;
          hilog.info(0x0000, 'dsh-mobile', '已由壳换取会话 cookie');
        } else {
          // 换不到不代表不能进：真需要鉴权时页面自己会提示（与桌面「换取失败照常导航」一致）。
          hilog.warn(0x0000, 'dsh-mobile', '换取会话失败：%{public}s', ex.reason);
        }
      }
      const assets = await ensureLocalAssets(context, this.base, cookie);
      const plugin = readBundledPlugin(context);
      const host = await LocalHost.start({
        remoteBase: this.base,
        cookie: cookie,
        distDir: assets.dir,
        distFiles: assets.files,
        pluginClientJs: plugin,
        pluginRev: assets.entry,
      });
      this.localHost = host;
      this.url = host.url;
      hilog.info(0x0000, 'dsh-mobile', '本地资产就绪：%{public}s（产物 %{public}s）', host.url, assets.entry);
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(0x0000, 'dsh-mobile', '本地资产失败，回退远程地址：%{public}s', e.message);
    }
  }

  build() {
    Column() {
      // 无顶部栏：系统左缘右滑返回手势直接回上一页（router 栈默认支持）。
      // renderMode 属于 WebOptions（不是链式属性）：ASYNC_RENDER 走自渲染管线，
      // 滚动/动画帧率明显好于同步渲染（#147 卡顿对策）。
      Web({ src: this.url, controller: this.controller, renderMode: RenderMode.ASYNC_RENDER })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        // ArkWeb 性能开关：异步渲染（自渲染管线）显著改善滚动/动画帧率；
        // 关闭回弹与横行滚动条，减少多余的重绘与手势竞争。
        .overScrollMode(OverScrollMode.NEVER)
        .horizontalScrollBarAccess(false)
        .zoomAccess(false)
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

  /**
   * ArkWeb 预热：对当前地址做预连接（DNS + TCP/TLS）与预解析，首屏少一程往返（#147）。
   * 预热失败一律静默降级——它不是加载的前置条件。
   */
  private preconnect(): void {
    if (this.url === '' || this.url === 'about:blank') return;
    try {
      // 静态方法（3 参）：对目标地址预建 numSockets 条连接并预解析，首屏省一程往返。
      webview.WebviewController.prepareForPageLoad(this.url, true, 2);
    } catch (e) {
      const err = e as Error;
      hilog.info(DOMAIN, TAG, 'prepareForPageLoad skipped: %{public}s',
        err !== undefined && err !== null && err.message !== undefined ? err.message : String(e));
    }
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
