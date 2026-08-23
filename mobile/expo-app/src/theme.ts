// 三端设计令牌（DeepSeek 官方配色 · 浅色主题，2026-08-23）
// 浅底 #f5f5f7（chat.deepseek.com 实测）；白卡片 #ffffff；
// 主文近黑 #1d1d1f；次文灰 #81858c；主操作蓝 #5686FE（正蓝不偏紫）。
// 与 H5 壳 / ArkUI 同值。
export const palette = {
  bg: '#f5f5f7', // 浅色页面底
  panel: '#ffffff', // 卡片（白）
  panel2: '#efeff4', // 次级面板（seg/qr 底）
  line: '#e5e5ea', // 分隔线（浅灰）
  text: '#1d1d1f', // 主文（近黑）
  text2: '#81858c', // 次文（灰）
  accent: '#5686FE', // 主操作蓝（chat 交互蓝）
  accentAlt: '#3964FE', // 按下/深蓝
  ok: '#2fbf71',
  warn: '#e5a13a',
  err: '#e5484d',
  off: '#999999', // 离线状态点
};

export const radii = {
  card: 14,
  btn: 10,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

// 深色主题 StyleSheet 基线（壳统一风格）
import { StyleSheet } from 'react-native';

export const shellStyles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: palette.bg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  // 顶部行：标题 + 右侧按钮（原型 .top）
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  addBtn: {
    backgroundColor: palette.accent,
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  addBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  card: {
    backgroundColor: palette.panel,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: palette.panel2 ?? palette.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    color: palette.text2,
    fontSize: 13,
    fontWeight: '600',
  },
  cardMeta: {
    flex: 1,
    minWidth: 0,
  },
  cardNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cardName: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
  cardAddr: {
    color: palette.text2,
    fontSize: 11,
    marginTop: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotOn: {
    backgroundColor: palette.ok,
  },
  dotOff: {
    backgroundColor: palette.off ?? '#4a5160',
  },
  enterBtn: {
    backgroundColor: palette.accent,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 5,
    flexShrink: 0,
  },
  enterBtnText: {
    color: '#fff',
    fontSize: 12,
  },
  delBtn: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.err,
    paddingHorizontal: 11,
    paddingVertical: 5,
    flexShrink: 0,
  },
  delBtnText: {
    color: palette.err,
    fontSize: 12,
  },
  longPressHint: {
    color: palette.text2,
    fontSize: 10,
    marginTop: 6,
    textAlign: 'right',
  },
  emptyBox: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: palette.line,
    borderRadius: radii.card,
    paddingVertical: 24,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  emptyText: {
    color: palette.text2,
    fontSize: 12,
    textAlign: 'center',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
    paddingTop: 8,
    alignItems: 'center',
    marginTop: 'auto',
  },
  footerText: {
    color: palette.text2,
    fontSize: 11,
  },
  // 分段控件（原型 .seg）
  seg: {
    flexDirection: 'row',
    backgroundColor: palette.panel2 ?? palette.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    borderRadius: 10,
    padding: 3,
    marginBottom: 14,
  },
  segBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
  },
  segBtnOn: {
    backgroundColor: palette.accent,
  },
  segText: {
    color: palette.text2,
    fontSize: 12,
  },
  segTextOn: {
    color: '#fff',
  },
  // 扫码占位（原型 .qrcode）
  qrBox: {
    width: 124,
    height: 124,
    backgroundColor: '#f5f5f2',
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrPlaceholder: {
    color: '#8a8a82',
    fontSize: 11,
    textAlign: 'center',
  },
  qrHint: {
    color: palette.text2,
    fontSize: 10,
    marginTop: 6,
    textAlign: 'center',
  },
  // 相机取景框（真扫码）
  cameraWrap: {
    borderRadius: radii.card,
    overflow: 'hidden',
    marginBottom: 8,
  },
  camera: {
    width: '100%',
    aspectRatio: 1,
  },
  title: {
    color: palette.text,
    fontSize: 20,
    fontWeight: '600',
  },
  sub: {
    color: palette.text2,
    fontSize: 13,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  input: {
    backgroundColor: palette.panel,
    borderColor: palette.line,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.btn,
    color: palette.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: spacing.sm,
  },
  btnPrimary: {
    backgroundColor: palette.accent,
    borderRadius: radii.btn,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnPrimaryText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  btnGhost: {
    borderRadius: radii.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnGhostText: {
    color: palette.text2,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  rowText: {
    color: palette.text,
    fontSize: 15,
    flexShrink: 1,
  },
  rowSub: {
    color: palette.text2,
    fontSize: 12,
    marginTop: 2,
  },
  errText: {
    color: palette.err,
    fontSize: 13,
    marginTop: spacing.sm,
  },
});