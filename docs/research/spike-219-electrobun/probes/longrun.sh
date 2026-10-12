#!/bin/bash
# #219 验收 ④：真实 dsh 前端 + 流式输出长跑观察（默认 60 分钟）
# 用法：bash /tmp/spike-219/longrun.sh [分钟]
MIN=${1:-60}
LOG=/tmp/spike-219/longrun.log
IPS_DIR="$HOME/Library/Logs/DiagnosticReports"
: > "$LOG"
echo "[$(date '+%F %T')] 长跑开始，计划 ${MIN} 分钟；CEF 页面 = spike（无 WebKit/WebContent 进程）" >> "$LOG"
ls "$IPS_DIR"/com.apple.WebKit.WebContent-*.ips 2>/dev/null | wc -l | tr -d ' ' | xargs -I{} echo "[$(date '+%F %T')] 起始 .ips 文件数 = {}" >> "$LOG"

i=0
while [ "$i" -lt "$MIN" ]; do
  i=$((i+1))
  TS=$(date '+%H:%M:%S')
  # CEF 渲染进程 RSS（按 --type=renderer 且属于 spike 的 helper 求和）
  REND=$(ps -Ao pid,rss,command | grep "spike-cef-dev.app/Contents/Frameworks" | grep -- "--type=renderer" | grep -v grep | awk '{s+=$2} END {printf "%.0f", s/1024}')
  RENDN=$(ps -Ao command | grep "spike-cef-dev.app/Contents/Frameworks" | grep -c -- "--type=renderer")
  IPS=$(ls "$IPS_DIR"/com.apple.WebKit.WebContent-*.ips 2>/dev/null | wc -l | tr -d ' ')
  PAGE=$(node /tmp/spike-219/sample.mjs 2>/dev/null | tail -1)
  echo "[$TS] t=${i}m renderer=${REND:-0}MB(${RENDN:-0}个) .ips=$IPS page=$PAGE" >> "$LOG"
  # 每 7 分钟发一条消息，制造流式负载
  if [ $((i % 7)) -eq 0 ]; then
    echo "[$TS] ── 发一条消息（第 $((i / 7)) 轮）" >> "$LOG"
    node /tmp/spike-219/drive.mjs "继续：再写 600 字左右，分 6 段，逐段输出。" >> "$LOG" 2>&1
  fi
  sleep 60
done
echo "[$(date '+%F %T')] 长跑结束" >> "$LOG"
ls "$IPS_DIR"/com.apple.WebKit.WebContent-*.ips 2>/dev/null | wc -l | tr -d ' ' | xargs -I{} echo "[$(date '+%F %T')] 结束 .ips 文件数 = {}" >> "$LOG"
