import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Theme } from '../common/Theme';
import { PairLogic } from '../common/PairLogic';
import { SessionGuard } from '../common/SessionGuard';
import { bundledEntry, cachedAssets, downloadFrontend, ensureLocalAssets, entryPathOf, exchangeSession, fetchRemoteHtml, loadCookie, readBundledAsset, readBundledPlugin } from '../common/LocalAssets';
import { LocalHost, entryNameOf } from '../common/LocalHost';
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
  /** 三选一状态：为 true 时页面被面板盖住（#155：不静默回退到远程页）。 */
  @State needChoice: boolean = false;
  /** 进三选一的原因（面板上直接显示，实机不用连 hilog 也能看出哪里错）。 */
  @State choiceReason: string = '';
  /** 三选一进行中：按钮置灰 + 面板显示进度（不能“闪一下没反应”）。 */
  @State choiceBusy: boolean = false;
  /** 下载进度（面板上显示“下载中 N/M：文件”，不能只有“正在准备…”）。 */
  @State choiceProgress: string = '';
  /** 扫码进来的原始入口地址（带 token）；只有**没被壳消费过**时才能回放给 ArkWeb。 */
  private rawEntryUrl: string = '';
  /** 壳是否已经拿这个 token 去换过会话（一次性凭据，换过就不能再给页面用）。 */
  private exchangeAttempted: boolean = false;

  aboutToAppear(): void {
    const params = (router.getParams() ?? {}) as Record<string, string>;
    this.rawEntryUrl = params['url'] ?? '';
    this.base = params['base'] ?? '';
    const rawUrl = params['url'] ?? PairLogic.buildEnterUrl(this.base);
    // #155 实机修复：配对链接是**一次性凭据**，而 token 只能被用掉一次。
    // 若先让 ArkWeb 去加载这个带 token 的地址，token 就被页面用掉了，壳随后的 /pair 换会话
    // 必然失败——症状正是手机扫码后「配对失败」。所以：是配对入口就**先停在 about:blank**，
    // 等壳自己换完会话、起好壳内服务再切过去。
    const entryPath = entryPathOf(rawUrl);
    this.url = entryPath !== '' ? 'about:blank' : rawUrl;
    void this.startLocalAssets(rawUrl, entryPath);
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
  private async startLocalAssets(rawUrl: string, entryPath: string): Promise<void> {
    if (!this.base) {
      this.url = rawUrl;
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      let cookie = await loadCookie(context, this.base);
      if (entryPath !== '') {
        // 一次性凭据：记下壳消费过它，这样「直接加载远程页面」时不会再回放一个已失效的 token。
        this.exchangeAttempted = true;
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
      await this.startHost(assets.dir, assets.entry);
    } catch (err) {
      // #155：失败**不静默回退**——进三选一，由用户决定（下载/用本地/开远程）。
      const e2 = err as BusinessError;
      this.choiceReason = e2.message;
      this.needChoice = true;
      const e = err as BusinessError;
      hilog.error(0x0000, 'dsh-mobile', '本地资产失败，回退远程地址：%{public}s', e.message);
    }
  }

  /**
   * 读壳里存的会话，并**同步种进 ArkWeb 的持久 cookie jar**——配对一次、长期复用，不必每次重扫。
   *（对应桌面 network/web_token.rs 的「会话 cookie 已原生种入 webview」。）
   */
  private async plantCookie(context: common.UIAbilityContext): Promise<string> {
    const cookie = await loadCookie(context, this.base);
    if (cookie !== '') {
      try {
        webview.WebCookieManager.configCookieSync(`http://${this.base}/`, cookie);
        hilog.info(DOMAIN, TAG, '会话已种入 ArkWeb 持久 jar（重启后无需重扫）');
      } catch (err) {
        const e = err as BusinessError;
        hilog.warn(DOMAIN, TAG, '种 cookie 失败：%{public}s', e.message);
      }
    }
    return cookie;
  }
  /** 起壳内 loopback 服务并把页面切过去（三选一里的「下载」与「用本地」都汇到这里）。 */
  private async startHost(distDir: string, entry: string): Promise<void> {

    const context = getContext(this) as common.UIAbilityContext;
    const plugin = readBundledPlugin(context);
    const host = await LocalHost.start({
      remoteBase: this.base,
      // 会话**同时种进 ArkWeb 的持久 cookie jar**（与桌面 web_token 同一步）：配对一次就要能长期复用，
      // 不开新码也能进——从前只存在 preferences 里，于是页面自己发出的请求不带 cookie（unpaired）。
      cookie: await this.plantCookie(context),
      distDir: distDir,
      // 随包内置 = 完整运行时：按请求路径直读 rawfile（无清单、无枚举）。distDir 为空时全靠它。
      readBundled: (rel: string) => readBundledAsset(context, rel),
      pluginClientJs: plugin,
      pluginRev: entry,
    });
    if (this.localHost !== undefined) {
      await this.localHost.stop();
    }
    this.localHost = host;
    this.url = host.url;
    hilog.info(0x0000, 'dsh-mobile', '本地资产就绪：%{public}s（产物 %{public}s）', host.url, entry);
    this.needChoice = false; // 真起来了才关面板（避免“闪一下没反应”）
  }

  /**
   * 三选一：「下载对应运行时」——与桌面远程模式同形：去**运行时包的分发处**取对应版本的前端产物，
   * 取完**重比**（远端入口名 vs 刚下的那份）——命中就用，仍不匹配就再问一次（桌面 ask_after_download）。
   */
  private async chooseDownload(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    this.choiceBusy = true;
    this.choiceReason = '正在从 npm 下载对应运行时…';
    try {
      const cookie = await loadCookie(context, this.base);
      const bundle = await downloadFrontend(context, this.base, cookie, (done: number, total: number, label: string) => {
        this.choiceProgress = `下载中 ${done}/${total}：${label}`;
      });
      const html = await fetchRemoteHtml(this.base, cookie);
      const remoteEntry = entryNameOf(html);
      if (remoteEntry !== bundle.entry) {
        this.choiceReason = `已下载 ${bundle.entry}，但远端当前是 ${remoteEntry}：请重选（可再下一次）`;
        this.choiceBusy = false;
        return;
      }
      await this.startHost(bundle.dir, bundle.entry);
    } catch (err) {
      const e = err as BusinessError;
      // BusinessError.message 常为空，真正定位要看 code（否则用户只看到“下载失败”四个字）。
      this.choiceReason = `下载失败[code=${e.code ?? '?'}] ${e.message ?? ''}`;
      hilog.error(DOMAIN, TAG, '下载运行时失败：%{public}s', this.choiceReason);
    }
    this.choiceBusy = false;
  }

  /** 三选一：「用当前本地运行时」——先沙箱缓存，其次**随包内置**那份（与桌面内置运行时同理）。 */
  private async chooseLocal(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    this.choiceBusy = true;
    const cached = await cachedAssets(context, this.base);
    this.choiceBusy = false;
    if (cached === null) {
      this.choiceReason = '本机没有任何可用产物（连随包的也没有，说明构建时没跑 sync-builtin.sh）';
      return;
    }
    // 「用当前本地运行时」= **随包内置那份**（distDir 空串 → 全程直读 rawfile）。
    await this.startHost('', bundledEntry(context));
  }

  /**
   * 三选一：「直接加载远程页面」。
   *
   * 关键一步：把壳持有的会话 cookie **种进 ArkWeb 的 cookie jar**（桌面做这件事的是

  /**
   * 三选一：「直接加载远程页面」——**只导航，不拦**。
   *
   * 为什么不需要壳里先有会话：远端那个地址（`host:3092`）是 lane 反代，扫码链接本身就是配对入口
   * `/pair?token=…`；让 ArkWeb 直接加载它，反代的 302 `set-cookie` 会把设备会话种进**页面自己的**
   * cookie jar，后续请求自然带上。（先前我拿“壳里没有会话”当门禁，把一条本来能走通的路堵死了。）
   *
   * 唯一要小心的是一次性 token：壳若已拿它换过会话（`exchangeAttempted`），就不能再回放，
   * 这时退到不带凭据的根地址（页面会自己提示需要配对，用户重扫一张即可）。
   */
  private async chooseRemote(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    const root = `http://${this.base}/`;
    let cookie = await loadCookie(context, this.base);
    // ① 与桌面同一步：壳自己拿 token 去换会话（/pair?token=… → set-cookie）。
    if (cookie === '' && !this.exchangeAttempted && this.rawEntryUrl !== '') {
      const entryPath = entryPathOf(this.rawEntryUrl);
      if (entryPath !== '') {
        this.exchangeAttempted = true;
        const ex = await exchangeSession(context, this.base, entryPath);
        if (ex.ok) {
          cookie = ex.cookie;
        } else {
          this.choiceReason = `换会话失败：${ex.reason}`;
        }
      }
    }
    // ② 与桌面同一步：**原生把 cookie 种进 webview 的 cookie jar**（桌面是 web_token）。
    if (cookie !== '') {
      try {
        webview.WebCookieManager.configCookieSync(root, cookie);
        hilog.info(DOMAIN, TAG, '会话 cookie 已原生种入 ArkWeb（与桌面 web_token 同一步）');
      } catch (err) {
        const e = err as BusinessError;
        hilog.warn(DOMAIN, TAG, '种 cookie 失败：%{public}s', e.message);
      }
    }
    // ③ 与桌面同一步：导航**不带 token 的根路径**。带 token 的 URL 会让 webview 走 token 校验
    //    分支，而它跨站过不去（桌面 #136 的终局：cookie 已种好仍然 401）——所以绝不把 token URL
    //    交给 ArkWeb（这也是之前「直接加载远程页面」白屏的真因）。
    hilog.info(DOMAIN, TAG, '导航到（不带 token）：%{public}s', root);
    this.needChoice = false;
    this.url = root;
    // 同上：改 src 不导航，必须显式 loadUrl。
    try {
      this.controller.loadUrl(root);
      hilog.info(0x0000, 'dsh-mobile', '已导航到远程页面：%{public}s', root);
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(0x0000, 'dsh-mobile', 'loadUrl（远程）失败：%{public}s', e.message);
    }

  }

  build() {
    // #155：三选一用 Stack 盖在页面上——**绝不静默回退**到直接加载远端页面。
    Stack() {
      this.webView()
      if (this.needChoice) {
        this.gatePanel()
      }
    }
    .width('100%')
    .height('100%')
  }

  /** 页面本体（原 build 的内容原样搬进来，只包一层名字）。 */
  @Builder
  webView() {
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
   * 三选一面板（与桌面远程模式、Expo 侧同构）：本地页面没跑起来时由用户决定，
   * 而不是壳自己默默开远程页。三个选项与桌面的 GATE_CHOICES 语义一一对应。
   */
  @Builder
  gatePanel() {
    Column({ space: 10 }) {
      Text('本地页面没跑起来').fontSize(16).fontWeight(FontWeight.Bold).fontColor(Theme.Text)
      Text(this.choiceBusy ? (this.choiceProgress !== '' ? this.choiceProgress : '正在准备…') : this.choiceReason).fontSize(12).fontColor(Theme.Text2).maxLines(3)
      Button('下载对应运行时（装完自动重比）')
        .width('100%')
        .onClick(() => { void this.chooseDownload(); })
      Button('用当前本地运行时（版本可能不符）')
        .width('100%')
        .onClick(() => { void this.chooseLocal(); })
      Button('直接加载远程页面')
        .width('100%')
        .enabled(!this.choiceBusy)
        .onClick(() => {
          void this.chooseRemote();
        })
    }
    .width('86%')
    .padding(18)
    .backgroundColor(Theme.Panel)
    .borderRadius(14)
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
