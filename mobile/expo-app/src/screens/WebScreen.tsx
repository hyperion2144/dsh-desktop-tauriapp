import { useRef } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Platform } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { palette } from '../theme';
import type { EnterTarget } from './HomeScreen';

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
          source={{ uri: target.url }}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          style={{ flex: 1 }}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          originWhitelist={['*']}
          onNavigationStateChange={(nav) => {
            if (androidBackRefs) {
              androidBackRefs.canGoBack.current = nav.canGoBack;
              androidBackRefs.goBack.current = () => webRef.current?.goBack();
            }
          }}
        />
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
        source={{ uri: target.url }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        style={{ flex: 1 }}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        originWhitelist={['*']}
      />
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