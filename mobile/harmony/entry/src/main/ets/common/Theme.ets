// 三端设计令牌（DeepSeek 官方配色 · 浅色主题，2026-08-23）
// 浅底 #f5f5f7（chat.deepseek.com 实测）；白卡片 #ffffff；
// 主文近黑 #1d1d1f；次文灰 #81858c；
// 主操作蓝 #5686FE（chat 交互蓝，正蓝不偏紫）；按下深蓝 #3964FE。
// 与 H5 壳（theme.ts）／RN 壳（src/theme.ts）同值。
export class Theme {
  static readonly Bg: string = '#f5f5f7';        // 浅色页面底（chat 实测）
  static readonly Panel: string = '#ffffff';     // 卡片（白）
  static readonly Panel2: string = '#efeff4';    // 次级面板（seg/qr 底）
  static readonly Line: string = '#e5e5ea';      // 分隔线（浅灰）
  static readonly Text: string = '#1d1d1f';      // 主文（近黑）
  static readonly Text2: string = '#81858c';     // 次文（灰）
  static readonly Accent: string = '#5686FE';    // 主操作蓝（chat 交互蓝）
  static readonly AccentBright: string = '#3964FE'; // 按下/深蓝
  static readonly Ok: string = '#2fbf71';
  static readonly Warn: string = '#e5a13a';
  static readonly Err: string = '#e5484d';
  static readonly Off: string = '#999999';

  static readonly RadiusCard: number = 14;
  static readonly RadiusBtn: number = 10;
  static readonly Sp4: number = 4;
  static readonly Sp8: number = 8;
  static readonly Sp12: number = 12;
  static readonly Sp16: number = 16;
  static readonly Sp24: number = 24;
}
