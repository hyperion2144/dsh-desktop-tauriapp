#!/usr/bin/env bash
# DeepSeek Harness Desktop · macOS 验收脚本（三条路径，源自实测验收清单）
# 用法：./scripts/acceptance.sh [binary] [port] [app_binary]
# 默认 binary=target/debug/dsh-desktop-tauriapp，port=3080，
# app_binary=src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app/Contents/MacOS/dsh-desktop-tauriapp
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${1:-target/debug/dsh-desktop-tauriapp}"
PORT="${2:-3080}"
APP_BIN="${3:-src-tauri/target/release/bundle/macos/DeepSeek Harness Desktop.app/Contents/MacOS/dsh-desktop-tauriapp}"

# 单实例锁检查：同 identifier 实例在跑时，验收进程会被静默转交并立即退出
#（exit 0 但零输出，造成假通过——必须前置检测）
if pgrep -q -f "dsh-desktop-tauriapp"; then
  echo "检测到已有 dsh-desktop-tauriapp 实例在运行，单实例锁会拦截验收进程。"
  echo "请先从托盘菜单退出 DeepSeek Harness Desktop（Cmd+Q 只是隐藏），再运行本脚本。"
  exit 2
fi

run_case() {
  local name="$1"; shift
  local log="/tmp/xnl-accept-$name.log"
  echo "=== [$name] ==="
  if "$@" >"$log" 2>&1; then
    echo "exit=0"
  else
    echo "FAIL(exit $?) —— 日志尾部："
    tail -15 "$log"
    exit 1
  fi
  if grep -qE "已导航到|正在停止 dsh|复用|拖拽区" "$log"; then
    grep -E "已导航到|正在停止 dsh|复用|拖拽区" "$log" | head -4
  else
    echo "(日志无关键行，完整见 $log)"
  fi
  echo
}

# A 复用路径（目标端口已有 dsh 服务时）
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  run_case "A-复用" env DSH_DESKTOP_AUTO_QUIT=1 "$BIN"
else
  echo "=== [A-复用] 跳过：$PORT 无现有服务 ==="
fi

# B 拉起 + 回收（用 port+1 验证 spawn 与子进程回收）
NEXT=$((PORT + 1))
run_case "B-拉起回收" env DSH_DESKTOP_PORT="$NEXT" DSH_DESKTOP_AUTO_QUIT=1 "$BIN"
sleep 1
if nc -z 127.0.0.1 "$NEXT" 2>/dev/null; then
  echo "FAIL: 端口 $NEXT 未回收"
  exit 1
fi
echo "端口 $NEXT 已回收 ✓"

# C GUI 启动场景（受限 PATH 模拟双击，仅对 .app 产物执行）
if [ -x "$APP_BIN" ]; then
  NEXT2=$((PORT + 2))
  run_case "C-受限PATH" env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    DSH_DESKTOP_PORT="$NEXT2" DSH_DESKTOP_AUTO_QUIT=1 "$APP_BIN"
else
  echo "=== [C-受限PATH] 跳过：未找到 app 产物（$APP_BIN，先 pnpm tauri build）==="
fi

# D 移动访问 lane（手机访问服务改写反代，默认 3091；被占自动 +1 探测）
# 需要桌面壳已拉起 dsh（A/B/C 任一已跑），lane 随 dsh web 启动。
LANE="${LANE_PORT:-3091}"
if nc -z 127.0.0.1 "$LANE" 2>/dev/null; then
  echo "=== [D-移动lane] 探测 $LANE ==="
  # /pair 应 200（配对入口，匿名可访问）
  PAIR_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$LANE/pair" 2>/dev/null || echo "000")
  # 属主 mint 应 200 + token（回环直连）
  MINT=$(curl -s --max-time 5 -X POST "http://127.0.0.1:$LANE/api/pair/mint" 2>/dev/null || echo "")
  MINT_CODE=$(echo "$MINT" | grep -o '"ok":true' | head -1 || true)
  if [ "$PAIR_CODE" = "200" ] && [ -n "$MINT_CODE" ]; then
    echo "移动 lane OK：/pair=$PAIR_CODE，mint 返回 ok:true ✓"
  else
    echo "FAIL: 移动 lane 异常 —— /pair=$PAIR_CODE mint=${MINT_CODE:-无}"
    exit 1
  fi
else
  echo "=== [D-移动lane] 跳过：$LANE 无服务（需桌面壳拉起 dsh 后运行）==="
fi

echo "验收完成 ✓"
