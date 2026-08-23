import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { Theme } from '../common/Theme';
import { PairLogic } from '../common/PairLogic';

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
        .layoutWeight(1)
        // 关键：让 Web 组件自身延伸到底部安全区（home indicator 之下），
        // 而不是根 Column 的背景色兜底——否则 webview 底部会留一条黑/背景色带。
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Theme.Bg)
  }
}
