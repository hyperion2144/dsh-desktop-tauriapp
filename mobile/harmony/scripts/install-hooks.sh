#!/usr/bin/env bash
# 安装仓库提交守卫到 .git/hooks（本仓库此前没有任何 hook 体系，故显式安装而非自动注入）。
#
# 装什么：pre-commit-guard.sh —— 拦截把鸿蒙壳 build-profile.json5 的签名口令提交上去。
# 为什么手动：往别人的 .git/hooks 里偷偷塞文件是不礼貌的；装不装由开发者自己决定。
#
# 用法：./scripts/install-hooks.sh          # 安装/更新
#       ./scripts/install-hooks.sh --uninstall

set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=$(git rev-parse --show-toplevel)
HOOK="$ROOT/.git/hooks/pre-commit"
GUARD="$(cd "$(dirname "$0")" && pwd)/pre-commit-guard.sh"

[ -x "$GUARD" ] || chmod +x "$GUARD"

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$HOOK" ] && grep -q "pre-commit-guard.sh" "$HOOK" 2>/dev/null; then
    rm -f "$HOOK"
    echo "已卸载 .git/hooks/pre-commit"
  else
    echo "没有本脚本安装的 hook，未改动任何文件。"
  fi
  exit 0
fi

# 已有非本脚本的 pre-commit：备份而非覆盖
if [ -f "$HOOK" ] && ! grep -q "pre-commit-guard.sh" "$HOOK" 2>/dev/null; then
  BAK="$HOOK.bak.$(date +%s)"
  cp "$HOOK" "$BAK"
  echo "检测到既有 pre-commit，已备份到：$BAK"
fi

cat > "$HOOK" <<EOF
#!/usr/bin/env bash
# 由 mobile/harmony/scripts/install-hooks.sh 安装；勿手工编辑。
exec "$GUARD"
EOF
chmod +x "$HOOK"

echo "已安装：$HOOK"
echo "  拦截目标：mobile/harmony/build-profile.json5 的签名材料"
echo "  自检：$(cd "$ROOT/mobile/harmony" && ./scripts/local-signing.sh --status | head -2 | tr '\n' ' ')"
echo "  绕过：git commit --no-verify"
