#!/usr/bin/env bash
# 把本机签名配置放回 build-profile.json5（该文件被 git 跟踪，签名材料不该进去）。
#
# 为什么需要：DevEco 的「自动签名」直接把 certpath/keyPassword/storePassword 写进
# build-profile.json5，而它是普通跟踪文件——一次 `git add` 就可能把口令带上远端。
# 约定：跟踪文件里 signingConfigs 留空，本机签名段存 .local/（已被 gitignore）。
#
# 用法：
#   ./scripts/local-signing.sh --save     # 从当前 build-profile.json5 抽出签名段存 .local/
#   ./scripts/local-signing.sh --apply    # 把 .local/ 里的签名段写回 build-profile.json5
#   ./scripts/local-signing.sh --status   # 看当前两边的状态
#
# 注意：--save 只**另存**，不改跟踪文件（避免脚本误清有效配置）；清空动作由人确认后手工做。

set -euo pipefail
cd "$(dirname "$0")/.."

BP=build-profile.json5
LOCAL_DIR=.local
LOCAL="$LOCAL_DIR/build-profile.signing.json5"

die() { echo "ERROR: $*" >&2; exit 1; }

# 抽签名段：从 "signingConfigs" 行到与之配对的 "],"
extract() {
  awk '
    /"signingConfigs"/ { inside=1 }
    inside { print }
    inside && /^[[:space:]]*\],[[:space:]]*$/ { exit }
  ' "$BP"
}

status() {
  echo "跟踪文件 $BP："
  if grep -q '"signingConfigs": \[\]' "$BP"; then
    echo "  signingConfigs: []（干净，可安全提交）"
  elif grep -q '"signingConfigs"' "$BP"; then
    echo "  ⚠ 含签名段 —— 提交前务必清空（否则口令进仓库）"
  else
    echo "  ⚠ 找不到 signingConfigs"
  fi
  echo "本机副本 $LOCAL："
  if [ -f "$LOCAL" ]; then
    echo "  存在（$(grep -c . "$LOCAL") 行，权限 $(stat -f '%Lp' "$LOCAL" 2>/dev/null || echo '?'))"
  else
    echo "  不存在（真机安装需先 DevEco 自动签名，或手工放一份到这里）"
  fi
}

case "${1:-}" in
  --status)
    status
    ;;
  --save)
    mkdir -p "$LOCAL_DIR"
    extract > "$LOCAL"
    [ -s "$LOCAL" ] || die "没抽到签名段——$BP 里 signingConfigs 可能是空的。"
    chmod 600 "$LOCAL"
    echo "已另存签名段 → $LOCAL"
    echo "手工清空 $BP 里的签名段，改回：\"signingConfigs\": [],"
    echo "（本脚本不自动改跟踪文件，避免误清；清空后 git diff 应只剩可移植配置）"
    ;;
  --apply)
    [ -f "$LOCAL" ] || die "找不到 $LOCAL。先用 DevEco 自动签名，再 --save。"
    grep -q '"signingConfigs": \[\]' "$BP" \
      || die "$BP 的 signingConfigs 不是空数组，先手工确认，避免覆盖有效配置。"
    # 用本机签名段替换空的 signingConfigs
    awk -v loc="$LOCAL" '
      /"signingConfigs": \[\]/ {
        while ((getline line < loc) > 0) print line
        close(loc)
        next
      }
      { print }
    ' "$BP" > "$BP.tmp" && mv "$BP.tmp" "$BP"
    echo "已把 $LOCAL 的签名段写回 $BP"
    echo "⚠ 现在 $BP 含口令：不要 git add 它；提交前跑 ./scripts/local-signing.sh --status 确认。"
    ;;
  *)
    sed -n '2,18p' "$0"
    exit 1
    ;;
esac
