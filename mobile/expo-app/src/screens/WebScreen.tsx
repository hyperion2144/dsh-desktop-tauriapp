import { useRef } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Platform } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { palette } from '../theme';
import type { EnterTarget } from './HomeScreen';
import { useSessionGuard } from '../lib/use-session-guard';
import { useRemotePorts } from '../lib/use-remote-ports';
import { useRemoteSession } from '../lib/use-remote-session';
import { SessionOverlay } from '../lib/session-overlay';
import { emptyState, entryPathOf } from '../lib/remote-entry';
import { appDistCache } from '../lib/expo-file-port';

export interface AndroidBackRefs {
  /** WebView 内部历史能否后退（onNavigationStateChange 更新） */
  canGoBack: { current: boolean };
  /** 让 WebView 后退一步 */
  goBack: { current: () => void };
}

export function WebScreen({ target, onBack, androidBackRefs }: {
  target: EnterTarget;
  onBack: () => void;
  androidBackRefs?: AndroidBackRefs;
}) {
  const webRef = useRef<WebView>(null);
  // #144 会话守卫：回前台/网络换代 → 探针 → 页面内轻量重连优先；仅页面已无法执行脚本时才兜底重载。
  const guard = useSessionGuard(webRef, target.base);
  // #155：本地资产 + 远程数据。进页面前先跑一遍「换会话 → 检测远端版本 → 命中则起壳内 loopback 服务」。
  // 就绪前先占位；但**配对入口不能占位成它自己**——那个地址带一次性 token，WebView 一加载就把它
  // 用掉了，壳随后 /pair 换会话必然失败（手机端实测到的「配对失败」）。于是配对入口先停 about:blank。
  const entryPath = entryPathOf(target.url);
  const placeholderUrl = entryPath ? 'about:blank' : target.url;
  const { ports, error: portsError } = useRemotePorts({
    base: target.base ?? null,
    entryPath,
    // #155：持久化缓存（文件端口 = expo-file-system）——冷启动直接读沙箱里那份前端产物，
    // 不再重下几 MB；缓存残缺时 dist-cache 会拒认并回落到下载。
    cache: appDistCache,
  });
  const { controller, state } = useRemoteSession({ ports, fallbackUrl: target.url });
  const pageUrl = state?.url ?? placeholderUrl;
  // 会话**种进 WebView 的 cookie jar**（对应桌面 `web_token`、鸿蒙 `plantCookie`）：
  // 页面靠自己发的请求就会带会话，不必每次都经壳代理；没有会话时保持 undefined。
  const sessionCookie = ports?.cookie ?? null;
  const cookieBootstrap = sessionCookie
    ? `try{document.cookie=${JSON.stringify(`${sessionCookie}; path=/`)};}catch(e){}`
    : undefined;
  const overlay = (
    <SessionOverlay
      state={portsError ? { ...emptyState, phase: 'error', reason: portsError } : state}
      onChoose={(choice) => void controller?.choose(choice)}
      onRetry={() => void controller?.start()}
    />
  );

  function onShouldStartLoadWithRequest(nav: WebViewNavigation): boolean {
    // 外链（非当前 base 域名）交系统浏览器；应用内导航放行。
    try {
      const cur = new URL(nav.url);
      const want = new URL(target.url);
      if (cur.host !== want.host && nav.navigationType === 'other') {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  // Android：系统手势返回（edge back）有效，不显示顶部栏，WebView 全屏。
  // iOS：返回手势无效，必须保留顶部返回栏（SafeAreaView 避让状态栏）。
  if (Platform.OS === 'android') {
    return (
      <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <WebView
          ref={webRef}
          source={{ uri: pageUrl }}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          style={{ flex: 1 }}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          originWhitelist={['*']}
          injectedJavaScriptBeforeContentLoaded={cookieBootstrap}
          onMessage={guard.onMessage}
          onRenderProcessGone={guard.onRenderProcessGone}
          onNavigationStateChange={(nav) => {
            if (androidBackRefs) {
              androidBackRefs.canGoBack.current = nav.canGoBack;
              androidBackRefs.goBack.current = () => webRef.current?.goBack();
            }
          }}
        />
        {overlay}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      {/* iOS 必须保留顶部返回栏（返回手势无效）；RN 内置 SafeAreaView 在 iOS
          自动给顶部加安全区 padding，让返回按钮避开 iPad 状态栏。 */}
      <SafeAreaView style={styles.safeTop}>
        <View style={styles.bar}>
          <Pressable onPress={onBack} hitSlop={8}>
            <Text style={styles.back}>‹ 返回</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {target.name}
          </Text>
          <Pressable onPress={() => webRef.current?.reload()} hitSlop={8}>
            <Text style={styles.back}>⟳</Text>
          </Pressable>
        </View>
      </SafeAreaView>
      <WebView
        ref={webRef}
        source={{ uri: pageUrl }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        style={{ flex: 1 }}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={cookieBootstrap}
        onMessage={guard.onMessage}
        onContentProcessDidTerminate={guard.onRenderProcessGone}
      />
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  safeTop: {
    backgroundColor: palette.panel,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: palette.panel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  back: {
    color: palette.accent,
    fontSize: 15,
  },
  title: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
    marginHorizontal: 8,
  },
});