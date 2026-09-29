#!/usr/bin/env bash
# 把「内置前端产物」与「布局插件」拷进鸿蒙壳的 rawfile（#155：随包分发）。
#
# 为什么必须有这一步：桌面的内置运行时是随 .app 打进去的，手机侧同理——没有随包产物时，
# 三选一里的「用当前本地运行时」永远是空的（首次安装必然如此），而这恰恰是它该最有用的场景。
# 内置哪一份：与桌面**同一 pin**（desktop/scripts/prepare-builtin-runtime.mjs 的 BUILTIN_DSH_VERSION），
# 这样手机与桌面命中同一个构建标识，版本闸门天然对齐。
#
# 用法：./scripts/sync-builtin.sh [dist目录] [插件client.js]
#   dist 缺省取桌面包里那份 staged 产物；插件缺省取 mobile/dsh-mobile-nav/lib/client.js。
set -euo pipefail
cd "$(dirname "$0")/.."

DIST="${1:-../../desktop/src-tauri/resources/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist}"
PLUGIN="${2:-../../mobile/dsh-mobile-nav/lib/client.js}"
OUT=entry/src/main/resources/rawfile

[ -f "$DIST/index.html" ] || {
  echo "ERROR: 找不到内置前端 dist：$DIST" >&2
  echo "  先跑 desktop/scripts/prepare-builtin-runtime.mjs（或 node desktop/scripts/prepare-builtin-runtime.mjs）" >&2
  exit 1
}

rm -rf "$OUT/dsh-frontend" "$OUT/plugins"
mkdir -p "$OUT/dsh-frontend" "$OUT/plugins/dsh-web-mobile"
cp -R "$DIST/." "$OUT/dsh-frontend/"

# 入口产物名（构建标识）：与 LocalHost.entryNameOf 同一规则 —— module script 的 basename。
ENTRY=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$OUT/dsh-frontend/index.html" | head -1 | sed 's|assets/||')
[ -n "$ENTRY" ] || { echo "ERROR: 从 index.html 认不出入口产物（形状变了？）" >&2; exit 1; }
printf '{"entry":"%s"}\n' "$ENTRY" > "$OUT/dsh-frontend-manifest.json"

if [ -f "$PLUGIN" ]; then
  cp "$PLUGIN" "$OUT/plugins/dsh-web-mobile/client.js"
  echo "布局插件已随包：$(du -h "$OUT/plugins/dsh-web-mobile/client.js" | cut -f1)"
else
  echo "WARN: 没有布局插件产物（$PLUGIN），手机端将不注入移动布局（Host 自己装了也能用）" >&2
fi

echo "内置前端产物：入口 $ENTRY，共 $(du -sh "$OUT/dsh-frontend" | cut -f1)"
