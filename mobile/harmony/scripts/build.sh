#!/usr/bin/env bash
# DeepSeek Harness Desktop · 鸿蒙壳本地构建脚本
#
# 为什么需要它：鸿蒙壳不随 CI 发布（.github/workflows/release.yml 明确排除），每次改动都得
# 本地 DevEco 构建。手工敲 DEVECO_SDK_HOME / JAVA_HOME / PATH 三件套容易漏（漏了报错又难懂），
# 本脚本把它固化，并在缺签名时给出准确提示而不是让人对着报错猜。
#
# 用法：
#   ./scripts/build.sh              # 构建，自动探测 DevEco 安装路径
#   DEVECO_STUDIO=/path/to/DevEco-Studio.app ./scripts/build.sh
#
# 产物：entry/build/default/outputs/default/entry-default-{signed,unsigned}.hap
# 装了真机后可：hdc install -r <signed.hap>

set -euo pipefail
cd "$(dirname "$0")/.."

DEVECO_STUDIO="${DEVECO_STUDIO:-/Applications/DevEco-Studio.app}"
SDK="${DEVECO_SDK_HOME:-$DEVECO_STUDIO/Contents/sdk}"
JBR="$DEVECO_STUDIO/Contents/jbr/Contents/Home"
TOOLS="$DEVECO_STUDIO/Contents/tools"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -d "$DEVECO_STUDIO" ] || die "找不到 DevEco Studio：$DEVECO_STUDIO
  安装后重试，或用 DEVECO_STUDIO=/path/to/DevEco-Studio.app 指定。"
[ -d "$SDK" ] || die "找不到 HarmonyOS SDK：$SDK
  在 DevEco Studio → Settings → SDK 中确认已安装 SDK。"
[ -x "$JBR/bin/java" ] || die "找不到 DevEco 自带 JBR：$JBR/bin/java"
[ -x "$TOOLS/hvigor/bin/hvigorw" ] || die "找不到 hvigorw：$TOOLS/hvigor/bin/hvigorw
  注意：本工程内没有 hvigorw 包装脚本，用的是 DevEco 自带的那个。"

export DEVECO_SDK_HOME="$SDK"
export JAVA_HOME="$JBR"
export PATH="$JAVA_HOME/bin:$TOOLS/ohpm/bin:$TOOLS/hvigor/bin:$TOOLS/node/bin:$PATH"

echo "DevEco : $DEVECO_STUDIO"
echo "SDK    : $SDK"
hvigorw --version 2>/dev/null | tail -1 || true
echo

# 依赖（ohpm）；无 oh-package-lock 时也安全（幂等）
if [ -f oh-package.json5 ]; then
  echo "=== ohpm install ==="
  ohpm install
fi

echo "=== assembleHap ==="
hvigorw --mode module -p module=entry@default assembleHap

OUT=entry/build/default/outputs/default
SIGNED="$OUT/entry-default-signed.hap"
[ -f "$SIGNED" ] || SIGNED="$OUT/entry-default-unsigned.hap"
[ -f "$SIGNED" ] || die "构建结束但没找到 HAP 产物，检查上面的构建日志。"

echo
echo "产物：$SIGNED"
if [ "${SIGNED##*-}" = "unsigned.hap" ]; then
  echo "提示：当前是未签名包（模拟器可用）。真机安装需先在 build-profile.json5 配置签名"
  echo "     （DevEco → File → Project Structure → Signing Configs 自动签名会写入，"
  echo "     该文件已被 git 跟踪，签名材料与口令切勿提交）。"
else
  echo "真机安装：hdc install -r $SIGNED"
fi
