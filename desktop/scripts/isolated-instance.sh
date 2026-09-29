#!/bin/sh
# 隔离验收实例（#154 及通用）：跑一个**绝不碰**用户正在用的 dsh 与桌面 App 的测试实例。
#
# 为什么要有这个脚本（2026-09-28 踩的坑）：用「空 desktop-settings.json + 全新 DSH_HOME」
# 起实例，壳没有 active_profile / 端口覆盖，于是按 web profile 的**默认端口 3080** 走
# 认领/修复路径，撞上用户正在跑的 dsh，用户被迫重启。三条硬规则从此写死在这里：
#
#   ① 独立 HOME + 独立 DSH_HOME——壳的 app data 也跟着 HOME 走，不会去碰真实安装的插件链接；
#   ② `DSH_HOME/desktop-settings.json` **逐项钉死**：active_profile / port / profile_ports /
#      profile_lane_ports / dsh_mode / dsh_runtime。端口默认 3180/3191（desktop 槽 3181/3192），
#      永不落在真实环境常用的 3080/3081/3092；
#   ③ profile 必须**已经初始化**（`profiles/<slot>/package.json` 存在）：没有就拒绝启动并说明
#      怎么建，而不是让壳去走「选择 profile / 修复」那条可能碰到别人的路。
#
# 端口被占用时**直接退出**——本脚本绝不 kill 任何进程。
#
# 用法：
#   desktop/scripts/isolated-instance.sh [实例根目录，默认 /tmp/dsh-iso]
#   DSH_ISO_PROFILE=web DSH_ISO_PORT=3180 DSH_ISO_LANE=3191 DSH_DESKTOP_LOG_SHELL_ORIGIN=1 \
#     desktop/scripts/isolated-instance.sh /tmp/dsh154
set -eu

ROOT="${1:-/tmp/dsh-iso}"
SLOT="${DSH_ISO_PROFILE:-web}"
PORT="${DSH_ISO_PORT:-3180}"
LANE="${DSH_ISO_LANE:-3191}"
DESKTOP_PORT=$((PORT + 1))
DESKTOP_LANE=$((LANE + 1))
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="${DSH_ISO_BIN:-$HERE/../src-tauri/target/debug/dsh-desktop-tauriapp}"

need_port_free() {
  busy=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$busy" ]; then
    echo "端口 $1 已被占用（pid $busy）——本脚本绝不 kill 别人的进程；请换端口或自行处理" >&2
    exit 1
  fi
}

[ -x "$BIN" ] || { echo "找不到可执行文件：$BIN（先 cargo build）" >&2; exit 1; }
mkdir -p "$ROOT/home" "$ROOT/dsh"
need_port_free "$PORT"
need_port_free "$LANE"

SETTINGS="$ROOT/dsh/desktop-settings.json"
if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<JSON
{
  "port": $PORT,
  "active_profile": "$SLOT",
  "profile_ports": { "$SLOT": $PORT, "desktop": $DESKTOP_PORT },
  "profile_lane_ports": { "$SLOT": $LANE, "desktop": $DESKTOP_LANE },
  "dsh_mode": "builtin",
  "remote_addr": null
}
JSON
  echo "已写隔离设置：$SETTINGS（端口 $PORT/$LANE，profile $SLOT）"
else
  echo "复用已有隔离设置：$SETTINGS"
fi

PROFILE_DIR="$ROOT/dsh/profiles/$SLOT"
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "profile「$SLOT」在隔离 home 里还没初始化：$PROFILE_DIR" >&2
  echo "先把 profile 建好再用本脚本（否则壳会走「选择 profile / 修复」路径）：" >&2
  echo "  mkdir -p '$ROOT/dsh/profiles' && cp -R <某个已初始化的 profiles/$SLOT> '$PROFILE_DIR'" >&2
  exit 1
fi

echo "隔离实例：HOME=$ROOT/home DSH_HOME=$ROOT/dsh profile=$SLOT 端口=$PORT lane=$LANE"
export HOME="$ROOT/home"
export DSH_HOME="$ROOT/dsh"
export DSH_DESKTOP_NO_SINGLETON=1
export DSH_DESKTOP_PORT="$PORT"
# forwarder（手机稳定接入点，settings.lane_port）与实例 lane（profile_lane_ports）必须分开，
# 否则 forwarder 抢先绑 127.0.0.1:<port>，流式代理连 lane 时会撞上 forwarder（实测 502，
# “连接目标 … Can't assign requested address”）。隔离环境两者相邻即可。
export DSH_MOBILE_LANE_PORT="$((LANE + 1))"
if [ -n "${DSH_DESKTOP_LOG_SHELL_ORIGIN:-}" ]; then
  export DSH_DESKTOP_LOG_SHELL_ORIGIN
fi
# 三类日志各自独立、互不混：① 壳 stdout/stderr → `$ROOT/app.log`；② 页面控制台 →
# `$DSH_HOME/dsh-desktop-webview.log`；③ lane（手机访问）→ `$DSH_HOME/mobile-access.log`。
echo "日志：$ROOT/app.log | $DSH_HOME/dsh-desktop-webview.log | $DSH_HOME/mobile-access.log"
exec "$BIN" >>"$ROOT/app.log" 2>&1
