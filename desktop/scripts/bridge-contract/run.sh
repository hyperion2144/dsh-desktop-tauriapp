#!/usr/bin/env bash
# 桥契约仿真测试（#118）：mock 壳环境下按 dsh ElectronWebViewImpl 时序驱动
# desktop-browser-bridge，断言 webview 标签兼容层的事件/方法/IPC 契约。
# 用法：desktop/scripts/bridge-contract/run.sh   （产物在 /tmp，浏览器打开后读 window.__RESULTS__）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # desktop/
REPO="$(cd "$ROOT/.." && pwd)"
OUT="$(mktemp -d /tmp/bridge-contract-XXXXXX)"
cat > "$OUT/wrapper.ts" <<EOF
import { installDesktopBrowserBridge } from '$REPO/src/client/desktop-browser-bridge.ts'
window.__installBridge = installDesktopBrowserBridge
EOF
npx --prefix "$REPO" esbuild "$OUT/wrapper.ts" --bundle --format=iife --outfile="$OUT/bridge.js" --log-level=error
cp "$(dirname "$0")/harness.html" "$OUT/harness.html"
echo "测试页已就绪：file://$OUT/harness.html"
echo "浏览器打开后控制台读 window.__RESULTS__（期望 22/22 PASS）；Tabbit 可直接 evaluate 断言。"
