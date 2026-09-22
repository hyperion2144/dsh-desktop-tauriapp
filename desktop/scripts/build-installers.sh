#!/usr/bin/env bash
# 出安装包（wayfinder #85/#91）：按变体 prepare → 门禁校验 → build → 挂载核验 → 拷贝 installers/
# 用法: scripts/build-installers.sh latest|alpha|both
# 每个变体构建后立即拷贝 installers/（防后续构建的目录清理吞掉已出产物）。
set -euo pipefail
# 后台任务环境可能缺用户 PATH（node 不在），先补常见工具目录
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
command -v node >/dev/null || { echo "FAIL: node 不可用"; exit 1; }
cd "$(dirname "$0")/../.."
SRC_TAURI="desktop/src-tauri"
INSTALLERS="installers"
APP_NAME="DeepSeek Harness Desktop"

# 单包流程：prepare（内置 latest）→ 门禁校验 → tauri build（主配置，无渠道后缀）→ 挂载核验 → 拷贝
node desktop/scripts/prepare-builtin-runtime.mjs --variant latest --skip-node
staged=$(node -p "JSON.parse(require('fs').readFileSync('$SRC_TAURI/resources/dsh/desktop-runtime.json','utf8')).variant")
[ "$staged" = "latest" ] || { echo "FAIL: staged variant=$staged"; exit 1; }
[ -f "$SRC_TAURI/resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || { echo "FAIL: staged 树缺 bin.js"; exit 1; }
rm -rf "$SRC_TAURI/target/release/bundle/macos/DeepSeek Harness Desktop.app" 2>/dev/null || true
(cd desktop && npx tauri build --bundles dmg > /tmp/build-dsh.log 2>&1) \
  || { echo "FAIL: tauri build 失败，日志 /tmp/build-dsh.log"; tail -20 /tmp/build-dsh.log; exit 1; }
APP_NAME="DeepSeek Harness Desktop"
DMG="$SRC_TAURI/target/release/bundle/dmg/${APP_NAME}_0.9.0_aarch64.dmg"
[ -f "$DMG" ] || { echo "FAIL: $DMG 未生成"; exit 1; }
mkdir -p "$INSTALLERS"
cp "$DMG" "$INSTALLERS/"
MNT="/tmp/dsh-verify"
hdiutil detach "$MNT" 2>/dev/null || true; rm -rf "$MNT"
hdiutil attach "$DMG" -mountpoint "$MNT" -nobrowse -quiet
APP_IN_DMG=$(ls -d "$MNT"/*.app | head -1)
EMBEDDED=$(node -p "JSON.parse(require('fs').readFileSync('$APP_IN_DMG/Contents/Resources/dsh/desktop-runtime.json','utf8')).variant")
BIN_OK=1
[ -f "$APP_IN_DMG/Contents/Resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || BIN_OK=0
[ -f "$APP_IN_DMG/Contents/MacOS/dsh-node" ] || BIN_OK=0
[ -f "$APP_IN_DMG/Contents/Resources/plugins/dsh-desktop-tauriapp/lib/client.js" ] || BIN_OK=0
hdiutil detach "$MNT" -quiet
[ "$EMBEDDED" = "latest" ] && [ "$BIN_OK" = 1 ] || { echo "FAIL: dmg 核验失败"; exit 1; }
rm -rf "$INSTALLERS/$APP_NAME.app"
cp -R "$SRC_TAURI/target/release/bundle/macos/$APP_NAME.app" "$INSTALLERS/" 2>/dev/null || true
echo "=== 单包流程完成（dsh=$EMBEDDED, bin.js+sidecar+client 就位）==="
