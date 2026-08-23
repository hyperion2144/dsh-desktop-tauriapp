import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  Alert,
  Linking,
} from 'react-native';
import { shellStyles, palette } from '../theme';
import { parsePairInput, buildEnterUrl, type PairEntry } from '../lib/pair';
import {
  loadPairs,
  pairs,
  removePair,
  setActive,
  getActiveBase,
} from '../store';

export type EnterTarget = { url: string; base: string; name: string };

/** 探测一个 base 是否在线（fetch HEAD 到 base，成功=在线）。 */
function useOnline(base: string): boolean {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch(`http://${base}/`, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(t);
        if (!cancelled) setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };
    void probe();
    const iv = setInterval(probe, 30000); // 每 30s 刷新状态
    return () => { cancelled = true; clearInterval(iv); };
  }, [base]);
  return online;
}

/** 单个卡片：头像块 + 名称 + 状态点 + 地址 + 进入按钮（对齐原型 mobile-shell.html）。 */
function PairCard({ item, onEnter, onRemove }: {
  item: PairEntry; onEnter: (p: PairEntry) => void; onRemove: (base: string) => void;
}) {
  const online = useOnline(item.base);
  const initial = (item.name ?? item.base).trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={shellStyles.card}>
      <View style={shellStyles.cardRow}>
        <View style={shellStyles.avatar}>
          <Text style={shellStyles.avatarText}>{initial}</Text>
        </View>
        <View style={shellStyles.cardMeta}>
          <View style={shellStyles.cardNameRow}>
            <Text style={shellStyles.cardName} numberOfLines={1}>{item.name ?? item.base}</Text>
            <View style={[shellStyles.dot, online ? shellStyles.dotOn : shellStyles.dotOff]} />
          </View>
          <Text style={shellStyles.cardAddr} numberOfLines={1}>
            {item.base}
            {getActiveBase() === item.base ? ' · 最近使用' : ''}
          </Text>
        </View>
        <Pressable style={shellStyles.enterBtn} onPress={() => onEnter(item)}>
          <Text style={shellStyles.enterBtnText}>进入</Text>
        </Pressable>
        <Pressable style={shellStyles.delBtn} onPress={() => onRemove(item.base)}>
          <Text style={shellStyles.delBtnText}>删除</Text>
        </Pressable>
      </View>
      <Pressable onLongPress={() => onRemove(item.base)}>
        <Text style={shellStyles.longPressHint}>长按删除</Text>
      </Pressable>
    </View>
  );
}

export function HomeScreen({ onEnter, onAdd }: {
  onEnter: (t: EnterTarget) => void;
  onAdd: () => void;
}) {
  const [list, setList] = useState<PairEntry[]>([]);

  const refresh = useCallback(() => setList([...pairs()]), []);

  useEffect(() => {
    void loadPairs().then(refresh);
    void Linking.getInitialURL().then((u) => {
      if (u) handleDeepLink(u);
    });
    const sub = Linking.addEventListener('url', ({ url }) => handleDeepLink(url));
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDeepLink(url: string) {
    const p = parsePairInput(url);
    if (!p) return;
    enterPair({ ...p, name: '扫码配对' });
  }

  function enterPair(p: PairEntry) {
    setActive(p.base);
    // 列表进入：永远走 base 首页（cookie 已种，自动放行）。
    // 绝不用 entryUrl——那是配对链接（/pair?token=..），令牌一次性已用掉，
    // 重复访问必失败（"配对失败，令牌过期"）。配对成功的 cookie 在 WebView 里。
    onEnter({ url: buildEnterUrl(p.base), base: p.base, name: p.name ?? p.base });
  }

  function onRemove(base: string) {
    Alert.alert('删除配对', `确定删除 ${base} 吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { removePair(base); refresh(); } },
    ]);
  }

  return (
    <View style={shellStyles.page}>
      {/* 顶部：标题 + 添加配对按钮（原型 .top） */}
      <View style={shellStyles.topRow}>
        <Text style={shellStyles.title}>DSH Mobile</Text>
        <Pressable style={shellStyles.addBtn} onPress={onAdd}>
          <Text style={shellStyles.addBtnText}>添加配对</Text>
        </Pressable>
      </View>

      <FlatList
        data={list}
        keyExtractor={(it) => it.base}
        renderItem={({ item }) => (
          <PairCard item={item} onEnter={enterPair} onRemove={onRemove} />
        )}
        ListEmptyComponent={
          <View style={shellStyles.emptyBox}>
            <Text style={shellStyles.emptyText}>还没有配对？扫码或输入配对地址完成配对</Text>
          </View>
        }
      />

      {/* 底部 footer（原型 .footer） */}
      <View style={shellStyles.footer}>
        <Text style={shellStyles.footerText}>配对 = 一次性令牌 + 会话 Cookie</Text>
      </View>
    </View>
  );
}
