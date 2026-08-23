import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { shellStyles, palette } from '../theme';
import { parsePairInput, type PairEntry } from '../lib/pair';

/** 扫码面板：expo-camera 实时扫码（对齐原型 vScan）。 */
function ScanPane({ onScanned }: { onScanned: (url: string) => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [manual, setManual] = useState(false);

  if (!perm) return <Text style={shellStyles.sub}>请求相机权限中…</Text>;
  if (!perm.granted) {
    return (
      <View>
        <Text style={shellStyles.sub}>需要相机权限扫描配对二维码</Text>
        <Pressable style={shellStyles.btnPrimary} onPress={requestPerm}>
          <Text style={shellStyles.btnPrimaryText}>授权相机</Text>
        </Pressable>
      </View>
    );
  }

  if (manual) {
    return (
      <View>
        <Text style={shellStyles.sub}>粘贴桌面端显示的配对链接</Text>
        <TextInput
          style={shellStyles.input}
          placeholder="dsh-mobile://pair?token=…"
          placeholderTextColor={palette.text2}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={(e) => onScanned(e.nativeEvent.text)}
        />
        <Pressable style={shellStyles.btnGhost} onPress={() => setManual(false)}>
          <Text style={shellStyles.btnGhostText}>回到扫码</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <Text style={shellStyles.sub}>扫描桌面端「设置 → 手机访问」的配对二维码</Text>
      <View style={shellStyles.cameraWrap}>
        <CameraView
          style={shellStyles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScanned(data)}
        />
      </View>
      <Pressable style={shellStyles.btnGhost} onPress={() => setManual(true)}>
        <Text style={shellStyles.btnGhostText}>相机不可用？手动输入</Text>
      </Pressable>
    </View>
  );
}

export function AddPairScreen({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (p: PairEntry) => void;
}) {
  const [tab, setTab] = useState<'scan' | 'input'>('scan');
  const [input, setInput] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');

  function parseAndDone(raw: string, extraToken = '') {
    const p = parsePairInput(raw, extraToken);
    if (!p) {
      setErr('无法解析：请粘贴 dsh-mobile:// 链接、http(s) 配对链接，或输入 host:端口 并填写令牌');
      return;
    }
    setErr('');
    onDone(p);
  }

  return (
    <View style={shellStyles.page}>
      {/* 顶部：标题 + 返回（原型 .top） */}
      <View style={shellStyles.topRow}>
        <Text style={shellStyles.title}>添加配对</Text>
        <Pressable style={shellStyles.btnGhost} onPress={onCancel}>
          <Text style={shellStyles.btnGhostText}>返回</Text>
        </Pressable>
      </View>

      {/* 分段控件：扫码配对 / 输入地址（原型 .seg） */}
      <View style={shellStyles.seg}>
        <Pressable
          style={[shellStyles.segBtn, tab === 'scan' && shellStyles.segBtnOn]}
          onPress={() => setTab('scan')}
        >
          <Text style={[shellStyles.segText, tab === 'scan' && shellStyles.segTextOn]}>扫码配对</Text>
        </Pressable>
        <Pressable
          style={[shellStyles.segBtn, tab === 'input' && shellStyles.segBtnOn]}
          onPress={() => setTab('input')}
        >
          <Text style={[shellStyles.segText, tab === 'input' && shellStyles.segTextOn]}>输入地址</Text>
        </Pressable>
      </View>

      {tab === 'scan' && <ScanPane onScanned={(u) => parseAndDone(u)} />}

      {tab === 'input' && (
        <View>
          <Text style={[shellStyles.sub, { marginTop: 4 }]}>
            输入配对地址（host:port 或完整配对链接）
          </Text>
          <TextInput
            style={shellStyles.input}
            placeholder="192.168.1.23:3091 或 dsh-mobile://pair?token=…"
            placeholderTextColor={palette.text2}
            autoCapitalize="none"
            autoCorrect={false}
            value={input}
            onChangeText={setInput}
          />
          <TextInput
            style={shellStyles.input}
            placeholder="配对令牌（链接已含令牌时可留空）"
            placeholderTextColor={palette.text2}
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            onChangeText={setToken}
          />
        </View>
      )}

      {err ? <Text style={shellStyles.errText}>{err}</Text> : null}

      <Pressable
        style={[shellStyles.btnPrimary, { marginTop: 14 }]}
        onPress={() => parseAndDone(input, token)}
      >
        <Text style={shellStyles.btnPrimaryText}>配对并进入</Text>
      </Pressable>

      <Text style={[shellStyles.sub, { marginTop: 10, textAlign: 'center' }]}>
        令牌一次性 + 限时；配对成功后从列表进入，同一桌面仅一个实例
      </Text>
    </View>
  );
}
