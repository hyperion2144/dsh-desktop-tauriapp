#!/usr/bin/env bash
# DeepSeek Harness Desktop · 代理注入验收脚本（map《托盘代理设置》验收票 #33）
#
# 覆盖三模式端到端：off 直连零注入 / manual 手动代理全套变量 / system 继承系统代理
# （启用跟随 + 全禁用回退）+ 设置保存 → 自动重启后新配置生效。
#
# 原理：
# - DSH_BIN 指向本脚本草配的 fake dsh：转储自身环境 + 在 --port 上起极简 HTTP 服务
#   （守护器判活 = TCP 连接成功），转储即「dsh 子进程环境」的铁证；
# - PATH 前置 shim scutil：cat 出脚本控制的 canned 输出，模拟「系统代理已修改」
#   （system 模式 spawn 时实时读取 → 重启前后各配一份即可验证跟随语义），
#   绝不改真实系统代理设置；
# - DSH_HOME 指向临时目录，settings.yaml 完全隔离，不碰用户真实配置；
# - 保存→重启链路走 DSH_DESKTOP_PROXY_RESTART_TEST 测试钩子（lib.rs）：直接调
#   save_proxy_settings + restart_dsh_service 两个真实命令（表单 JS 只是薄封装）。
#
# 用法：./scripts/acceptance-proxy.sh [binary]
# 默认 binary=target/debug/dsh-desktop-tauriapp（需包含 PROXY_RESTART_TEST 钩子）。
# Windows 编译按仓库惯例由 CI 把关，本脚本仅覆盖 macOS 本地验收。
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${1:-src-tauri/target/debug/dsh-desktop-tauriapp}"

fail() { echo "FAIL: $1"; exit 1; }

[ -x "$BIN" ] || fail "二进制不存在或不可执行：$BIN（先 cargo build）"
# 钩子存在性检查：老二进制没有 PROXY_RESTART_TEST 钩子会静默跳过保存重启用例
grep -aq "DSH_DESKTOP_PROXY_RESTART_TEST" "$BIN" \
  || fail "二进制不含 DSH_DESKTOP_PROXY_RESTART_TEST 测试钩子（重新编译最新 lib.rs）"

# 正式实例并行提示：用例带 DSH_DESKTOP_NO_SINGLETON=1（lib.rs 测试钩子）跳过单实例互斥，
# 与正在运行的正式实例可并行（端口/DSH_HOME 均隔离）；仅提醒托盘会短暂多一个图标。
if pgrep -f "dsh-desktop-tauriapp" >/dev/null 2>&1; then
  echo "提示：检测到 dsh-desktop-tauriapp 实例在运行，用例以 NO_SINGLETON 隔离模式并行。"
fi

command -v node >/dev/null || fail "需要 node（fake dsh 的 HTTP 服务）"
NODE_BIN="$(command -v node)"

TMP="$(mktemp -d /tmp/dsh-proxy-accept.XXXXXX)"
DUMP="$TMP/dump.env"
SHIM="$TMP/shim"
mkdir -p "$SHIM" "$TMP/home"
cleanup() {
  [ -n "${LISTEN_PID:-}" ] && kill "$LISTEN_PID" 2>/dev/null || true
  pkill -f "$TMP/fake-dsh.sh" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---- 桩：fake dsh（转储环境 + 按参数起 HTTP 服务） ----
cat > "$TMP/fake-dsh.sh" <<EOF
#!/bin/bash
# 子进程环境转储：追加式，每个 exec 一段（=== pid= 分隔），供重启用例区分两代 dsh
{ echo "=== pid=\$\$ args=\$* ==="; env; } >>"\$FAKE_DSH_DUMP"
# 提取 --port：守护器健康判定 = TCP 连接成功，起极简 HTTP 服务
PORT=3080
prev=""
for a in "\$@"; do
  [ "\$prev" = "--port" ] && PORT="\$a"
  prev="\$a"
done
exec "$NODE_BIN" -e '
  const http = require("http");
  const port = Number(process.argv[1]) || 3080;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>fake-dsh</body></html>");
  });
  srv.on("error", (e) => { console.error("[fake-dsh] listen failed:", e.message); process.exit(1); });
  srv.listen(port, "127.0.0.1", () => console.log("[fake-dsh] listening on " + port));
' "\$PORT"
EOF
chmod +x "$TMP/fake-dsh.sh"

# ---- 桩：shim scutil（输出脚本控制的 canned 文本，模拟系统代理状态变化） ----
cat > "$SHIM/scutil" <<EOF
#!/bin/bash
cat "\$SCUTIL_SHIM_OUT"
EOF
chmod +x "$SHIM/scutil"
: > "$DUMP"
SCUTIL_OFF_TXT="$TMP/scutil-off.txt"
SCUTIL_ON_TXT="$TMP/scutil-on.txt"
# 全禁用（含例外列表/配置残留），格式对齐研究票 §1.2 真实样例
cat > "$SCUTIL_OFF_TXT" <<'EOF'
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
EOF
# HTTP/HTTPS/SOCKS 三协议启用（无 PAC），格式对齐研究票 §1.3 样例结构
cat > "$SCUTIL_ON_TXT" <<'EOF'
<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : *.internal.example
  }
  HTTPEnable : 1
  HTTPPort : 8899
  HTTPProxy : 10.7.7.7
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 10.7.8.8
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 10.7.9.9
}
EOF

write_settings() {
  cat > "$TMP/home/settings.yaml" <<EOF
dsh-desktop-tauriapp:
  proxy_mode: $1
EOF
  if [ -n "${2:-}" ]; then echo "  proxy_url: $2" >> "$TMP/home/settings.yaml"; fi
  if [ -n "${3:-}" ]; then echo "  no_proxy: \"$3\"" >> "$TMP/home/settings.yaml"; fi
}

# 空闲端口探测（每用例独立端口，避免 TIME_WAIT/占用干扰）
free_port() {
  local p
  for p in $(seq "$1" "$(( $1 + 40 ))"); do
    if ! nc -z 127.0.0.1 "$p" 2>/dev/null; then
      echo "$p"; return 0
    fi
  done
  return 1
}

# 启动桌面壳跑一个用例：等待 AUTO_QUIT 自退，校验端口回收
run_app() {
  local name="$1"; shift
  local port="$1"; shift
  local log="$TMP/log-$name.log"
  env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
      -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy \
      DSH_HOME="$TMP/home" \
      DSH_BIN="$TMP/fake-dsh.sh" \
      DSH_DESKTOP_PORT="$port" \
      DSH_DESKTOP_AUTO_QUIT=1 \
      DSH_DESKTOP_NO_SINGLETON=1 \
      PATH="$SHIM:/usr/bin:/bin:/usr/sbin:/sbin" \
      SCUTIL_SHIM_OUT="${SCUTIL_SHIM_OUT:-}" \
      FAKE_DSH_DUMP="$DUMP" \
      "$@" "$BIN" >"$log" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 40 ]; then
      echo "FAIL: [$name] 40s 未自退（AUTO_QUIT 未触发）—— 日志尾部："
      tail -20 "$log"
      kill "$pid" 2>/dev/null || true
      exit 1
    fi
  done
  wait "$pid" 2>/dev/null || true
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    echo "FAIL: [$name] 端口 $port 未回收 —— 日志尾部："
    tail -20 "$log"
    exit 1
  fi
}

# 断言：第 N 段转储里环境变量 == 期望值（或缺席）
seg() { awk -v n="$1" '/^=== pid=/{c++} c==n' "$DUMP"; }
# 守卫：断言前先确认转储文件与目标段真实存在（防止空转假通过）
require_seg() {
  [ -s "$DUMP" ] || fail "转储文件不存在或为空：$DUMP（app 可能未启动）"
  seg "$1" | grep -q '^=== pid=' || fail "转储缺少第 $1 段（dsh 代数不足）"
}
assert_env() {
  local n="$1" var="$2" want="$3"
  require_seg "$n"
  if ! seg "$n" | grep -q "^${var}=${want}\$"; then
    echo "FAIL: 转储第 $n 段 $var 期望 [$want]，实际："
    seg "$n" | grep -E "^${var}=" || echo "  （${var} 缺席）"
    exit 1
  fi
}
assert_absent() {
  local n="$1"; shift
  require_seg "$n"
  local re
  re=$(printf '%s' "$@" | paste -sd'|' -)
  if seg "$n" | grep -Eq "^(${re})="; then
    echo "FAIL: 转储第 $n 段不应注入，却发现："
    seg "$n" | grep -E "^(${re})=" || true
    exit 1
  fi
}
PROXY_VARS="HTTP_PROXY http_proxy HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy"

case_n=0
check() {
  case_n=$((case_n + 1))
  echo "[$case_n] $1 ✓"
}

# ---------- 1. off 直连：代理变量全部缺席 ----------
P=$(free_port 3320)
: > "$DUMP"
write_settings off
run_app off "$P"
assert_absent 1 $PROXY_VARS
check "off 直连：8 个代理变量全部缺席（大小写各一），端口已回收"

# ---------- 2. manual 手动：本地起监听，配置后子进程环境含全套变量 ----------
P=$(free_port 3330)
MP=$(free_port 3370)
: > "$DUMP"
# 本地起端口监听作为手动代理端点（票面要求；python3 常驻接受守护器探活）
python3 -m http.server "$MP" --bind 127.0.0.1 >/dev/null 2>&1 &
LISTEN_PID=$!
sleep 0.5
nc -z 127.0.0.1 "$MP" >/dev/null 2>&1 || fail "本地监听 $MP 未就绪"
write_settings manual "http://127.0.0.1:$MP" "*.corp.example; 192.168.0.0/16; Foo.Example.COM"
run_app manual "$P"
kill "$LISTEN_PID" 2>/dev/null || true
wait "$LISTEN_PID" 2>/dev/null || true
unset LISTEN_PID
assert_env 1 HTTP_PROXY  "http://127.0.0.1:$MP"
assert_env 1 http_proxy  "http://127.0.0.1:$MP"
assert_env 1 HTTPS_PROXY "http://127.0.0.1:$MP"
assert_env 1 https_proxy "http://127.0.0.1:$MP"
# #31 裁定：http(s) 手动代理不注 ALL_PROXY（socks5 URL 才注）
assert_absent 1 ALL_PROXY all_proxy
# NO_PROXY 规范化：*前缀→.后缀、CIDR 丢弃、小写化、恒含回环保底（#31 单测语义）
assert_env 1 NO_PROXY  ".corp.example,foo.example.com,localhost,127.0.0.1,::1"
assert_env 1 no_proxy  ".corp.example,foo.example.com,localhost,127.0.0.1,::1"
check "manual 手动：HTTP(S)_PROXY 大小写全套 = 手动 URL，NO_PROXY 规范化+回环保底，本地监听端点在线"

# ---------- 3. system 继承（启用）：注入值实时跟随系统 ----------
P=$(free_port 3340)
: > "$DUMP"
SCUTIL_SHIM_OUT="$SCUTIL_ON_TXT"
write_settings system
run_app system-on "$P"
unset SCUTIL_SHIM_OUT
assert_env 1 HTTP_PROXY  "http://10.7.7.7:8899"
assert_env 1 http_proxy  "http://10.7.7.7:8899"
assert_env 1 HTTPS_PROXY "http://10.7.8.8:8443"
assert_env 1 https_proxy "http://10.7.8.8:8443"
assert_env 1 ALL_PROXY   "socks5://10.7.9.9:1080"
assert_env 1 all_proxy   "socks5://10.7.9.9:1080"
assert_env 1 NO_PROXY    "localhost,.internal.example,127.0.0.1,::1"
assert_env 1 no_proxy    "localhost,.internal.example,127.0.0.1,::1"
check "system 启用：HTTP/HTTPS/SOCKS 三路注入值实时跟随（scutil shim），NO_PROXY=例外∪回环"

# ---------- 4. system 回退（全禁用）：不注代理 URL，仅 NO_PROXY 保底 ----------
P=$(free_port 3350)
: > "$DUMP"
SCUTIL_SHIM_OUT="$SCUTIL_OFF_TXT"
run_app system-off "$P"
unset SCUTIL_SHIM_OUT
assert_absent 1 HTTP_PROXY http_proxy HTTPS_PROXY https_proxy ALL_PROXY all_proxy
# #31 单测裁定（parse_scutil_proxy_disabled_keeps_exceptions_only）：全禁用 →
# 无代理 URL，NO_PROXY 仍保底（例外列表 ∪ 回环）——「回退为不注入」指不注入代理
if ! seg 1 | grep -q "^NO_PROXY="; then
  fail "转储第 1 段缺少 NO_PROXY 保底"
fi
check "system 全禁用：代理 URL 零注入，NO_PROXY 例外∪回环保底（#31 裁定语义）"

# ---------- 5. 保存 → 自动重启：新配置生效 ----------
P=$(free_port 3360)
PA=$(free_port 3380)
PB=$(free_port 3390)
: > "$DUMP"
write_settings manual "http://127.0.0.1:$PA" "*.alpha.example"
# 用 export 显式传钩子参数（避免依赖函数前缀赋值的导出语义）
export DSH_DESKTOP_PROXY_RESTART_TEST=1
export DSH_DESKTOP_PROXY_RESTART_URL="http://127.0.0.1:$PB"
export DSH_DESKTOP_PROXY_RESTART_NO_PROXY="*.beta.example"
run_app save-restart "$P"
unset DSH_DESKTOP_PROXY_RESTART_TEST DSH_DESKTOP_PROXY_RESTART_URL DSH_DESKTOP_PROXY_RESTART_NO_PROXY
# 钩子在 +4s 用真实命令链路保存 URL_B 并触发重启：应有第二代 dsh 转储
require_seg 2
PID1=$(seg 1 | head -1 | sed -E 's/=== pid=([0-9]+).*/\1/')
PID2=$(seg 2 | head -1 | sed -E 's/=== pid=([0-9]+).*/\1/')
[ -n "$PID1" ] && [ -n "$PID2" ] && [ "$PID1" != "$PID2" ] \
  || fail "两代 dsh pid 未区分：pid1=$PID1 pid2=$PID2"
assert_env 1 HTTP_PROXY "http://127.0.0.1:$PA"
assert_env 2 HTTP_PROXY "http://127.0.0.1:$PB"
assert_env 2 HTTPS_PROXY "http://127.0.0.1:$PB"
assert_env 2 NO_PROXY ".beta.example,localhost,127.0.0.1,::1"
grep -q "proxy_url: http://127.0.0.1:$PB" "$TMP/home/settings.yaml" \
  || fail "settings.yaml 未持久化重启后的新 proxy_url"
check "保存→自动重启：save_proxy_settings+restart_dsh_service 真实链路，新代理注入生效且持久化（pid $PID1 → $PID2）"

echo
echo "代理注入验收完成 ✓（5/5：off / manual / system-on / system-off / save-restart）"
echo "Windows 编译按仓库惯例由 CI（.github/workflows/release.yml）把关。"
