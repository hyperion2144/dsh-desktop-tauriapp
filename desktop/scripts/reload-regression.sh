#!/usr/bin/env bash
# 「白屏 + 自动刷新」的回归判定脚本（① 的验收手段）。
#
# 背景（证据链见 CHANGELOG）：
#   页面 WebContent 常驻约 1.2 GB → WebKit 回收该进程 → 自动重载 →
#   新进程启动时 JavaScriptCore 在 async-iterator 上 SIGSEGV
#   （`~/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent-*.ips`，
#    三次崩溃 21:04:29 / 22:01:30 / 23:06:01 均紧跟一次文档重取）。
# 已落的两条缓解：①壳内流式代理给 SSE 加 30 分钟寿命上限；②桌面缺省启用视觉窗口化
#   （`mobile-render-budget.ts`，设置面板可关：desktop_render_budget）。
#
# 用法：desktop/scripts/reload-regression.sh [小时数，默认 24]
# 输出：该时间窗内的 崩溃次数 / 文档重取次数 / mux 建连次数 / 最近一次内存采样。
# 判定：改造后同一时间窗内 崩溃次数 应显著下降（理想为 0），文档重取次数同比例下降。
set -u

HOURS="${1:-24}"
LOG="$HOME/Library/Logs/com.arcreel.dsh-desktop-tauriapp/dsh-desktop-tauriapp.log"
REPORTS="$HOME/Library/Logs/DiagnosticReports"

echo "=== 窗口：最近 ${HOURS} 小时 ==="

if [ -d "$REPORTS" ]; then
  # 崩溃报告：按 mtime 过滤（文件名也带时间，但 mtime 更可靠）
  n=$(find "$REPORTS" -name 'com.apple.WebKit.WebContent-*.ips' -mmin -$((HOURS * 60)) 2>/dev/null | wc -l | tr -d ' ')
  echo "WebContent 崩溃报告：${n} 份"
  find "$REPORTS" -name 'com.apple.WebKit.WebContent-*.ips' -mmin -$((HOURS * 60)) 2>/dev/null \
    | sort | sed 's/^/  /' | tail -5
else
  echo "（找不到 $REPORTS）"
fi

if [ -f "$LOG" ]; then
  # 文档重取 = 页面被重新加载（崩溃后的自动重载也走这条路）
  # grep -c 在“无匹配”时退出码非 0、管道下还会多打一行；统一走这个助手避免噪声行。
  _cnt() { grep -c "$1" "$2" 2>/dev/null | head -1 || true; }
  reloads=$(_cnt "\[dshapp\] GET dshapp://localhost/" "$LOG"); reloads=${reloads:-0}
  mux=$(_cnt "WS /api/remote.mux -> 101" "$LOG"); mux=${mux:-0}
  crashes=$(_cnt "OnRenderProcessGone" "$LOG"); crashes=${crashes:-0}
  echo "壳日志累计——文档重取：${reloads} 次；mux 建连：${mux} 次；壳侧崩溃记录：${crashes} 次"
  echo "最近 3 次文档重取时刻："
  grep "\[dshapp\] GET dshapp://localhost/" "$LOG" 2>/dev/null | tail -3 | cut -c1-40 | sed 's/^/  /'
else
  echo "（找不到 $LOG）"
fi

# 内存采样：WebKit 每次上报都会写一条（有就显示最后一条）。
# 必须滤掉 log 命令自身写下的条目，否则会自匹配成“最近一次上报”。
sample=$(log show --predicate 'eventMessage CONTAINS "Current memory footprint"' --last "${HOURS}h" --style compact 2>/dev/null | grep -v "log run noninteractively" | tail -1)
if [ -n "$sample" ]; then
  echo "最近一次内存上报：$(echo "$sample" | cut -c1-120)"
else
  echo "（该窗口内没有内存上报；页面未接近压力阈值时也可能没有）"
fi

echo
echo "判定：与改造前的同一窗口对比「崩溃报告数」与「文档重取数」；两者同时下降才算缓解生效。"
