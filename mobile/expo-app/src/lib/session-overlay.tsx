// 会话状态浮层（#155）：三选一 + 进度/失败提示。
//
// 与桌面远程模式的对话框同构（文案同源：`GATE_CHOICES` 来自 shell-web 的单一事实源），
// 但手机端是**页面内浮层**而不是原生对话框：ArkWeb/WKWebView 里都能用同一套样式，也不用
// 给两个平台各写一遍原生 UI。
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { GATE_CHOICES } from '../../../shell-web/local-assets.mjs';
import { palette } from '../theme';
import type { SessionState } from './remote-controller';

/** 三选一的标题：闸门有结论就按结论说，没结论（下载失败等）就说清是哪种失败。 */
function gateTitle(state: SessionState): string {
  if (state.gate === null) return '本地页面没跑起来';
  return state.gate.kind === 'unavailable' ? '读不到远程版本' : '本地没有对应的前端产物';
}

export interface SessionOverlayProps {
  state: SessionState | null;
  /** 三选一的选择回传（remote-controller 的 choose）。 */
  onChoose: (choice: 'download' | 'useLocal' | 'remoteWebview') => void;
  /** 失败/回退后重试。 */
  onRetry?: () => void;
}

/** 只在需要挡住页面时渲染（working / gate / error）；ready / fallback 直接放行。 */
export function SessionOverlay({ state, onChoose, onRetry }: SessionOverlayProps) {
  if (!state || state.phase === 'ready' || state.phase === 'fallback' || state.phase === 'idle') return null;

  return (
    <View style={styles.wrap} pointerEvents="auto">
      <View style={styles.card}>
        {state.phase === 'working' ? (
          <View style={styles.row}>
            <ActivityIndicator color={palette.accent} />
            <Text style={styles.title}>正在准备本地页面…</Text>
          </View>
        ) : null}

        {state.phase === 'gate' ? (
          <>
            <Text style={styles.title}>{gateTitle(state)}</Text>
            <Text style={styles.desc}>{state.reason ?? ''}</Text>
            {GATE_CHOICES.map((c) => (
              <Pressable
                key={c.id}
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                onPress={() => onChoose(c.id as 'download' | 'useLocal' | 'remoteWebview')}
              >
                <Text style={styles.buttonText}>{c.label}</Text>
                <Text style={styles.buttonHint}>{c.hint}</Text>
              </Pressable>
            ))}
          </>
        ) : null}

        {state.phase === 'error' ? (
          <>
            <Text style={styles.title}>进入失败</Text>
            <Text style={styles.desc}>{state.reason ?? ''}</Text>
            {onRetry ? (
              <Pressable style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} onPress={onRetry}>
                <Text style={styles.buttonText}>重试</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {/* 诊断日志：真机上没有控制台，这里就是唯一的诊断面（失败时尤其要看）。 */}
        {state.logs.length > 0 ? (
          <View style={styles.logBox}>
            {state.logs.slice(-4).map((line, i) => (
              <Text key={i} style={styles.logLine} numberOfLines={1}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: palette.panel,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: palette.text, fontSize: 15, fontWeight: '600' },
  desc: { color: palette.text2, fontSize: 12, lineHeight: 18 },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 2,
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: palette.text, fontSize: 14, fontWeight: '600' },
  buttonHint: { color: palette.text2, fontSize: 11 },
  logBox: { marginTop: 4, gap: 2 },
  logLine: { color: palette.text2, fontSize: 10, fontFamily: 'Menlo' },
});
