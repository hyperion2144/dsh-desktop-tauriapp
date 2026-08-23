import { useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { HomeScreen, type EnterTarget } from './src/screens/HomeScreen';
import { AddPairScreen } from './src/screens/AddPairScreen';
import { WebScreen, type AndroidBackRefs } from './src/screens/WebScreen';
import { addPair, setActive } from './src/store';
import { buildEntryUrl, type PairEntry } from './src/lib/pair';

export default function App() {
  const [target, setTarget] = useState<EnterTarget | null>(null);
  const [adding, setAdding] = useState(false);

  // Android 系统返回：WebView 内部能后退则退，否则回主页。
  const androidBackRefs = useRef<AndroidBackRefs>({
    canGoBack: { current: false },
    goBack: { current: () => {} },
  });

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (target) {
        // 优先 WebView 内部历史后退（dsh 页内导航），再回主页
        if (androidBackRefs.current.canGoBack.current) {
          androidBackRefs.current.goBack.current();
        } else {
          setTarget(null);
        }
        return true; // 拦截
      }
      return false; // 默认：退出
    });
    return () => sub.remove();
  }, [target]);

  if (target) {
    return (
      <>
        <StatusBar style="dark" />
        <WebScreen
          target={target}
          onBack={() => setTarget(null)}
          androidBackRefs={androidBackRefs.current}
        />
      </>
    );
  }

  if (adding) {
    return (
      <>
        <StatusBar style="dark" />
        <AddPairScreen
          onCancel={() => setAdding(false)}
          onDone={(p: PairEntry) => {
            addPair(p);
            setActive(p.base);
            setAdding(false);
            setTarget({ url: buildEntryUrl(p), base: p.base, name: p.name ?? p.base });
          }}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <HomeScreen onEnter={setTarget} onAdd={() => setAdding(true)} />
    </>
  );
}
