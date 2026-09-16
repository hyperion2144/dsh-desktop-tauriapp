#!/usr/bin/env bash
# 提交守卫：阻止把鸿蒙壳的签名口令提交进仓库。
#
# 为什么需要：mobile/harmony/build-profile.json5 是**被 git 跟踪**的普通配置文件，而
# DevEco 的「自动签名」会往同一个文件里写 certpath/keyPassword/storePassword。于是
# 「改了一行配置 → git add 整个文件」就会把口令带上去，几乎不会有人察觉。
#
# 本守卫只拦不修：命中即退出 1 并打印该文件当前的签名段，由人决定怎么处理。
# 确实需要绕过时用 `git commit --no-verify`。

set -uo pipefail

TARGETS=("mobile/harmony/build-profile.json5" "desktop/src-tauri/tauri.conf.json")
# 只用不会出现在正常配置里的键："profile" 这类常见词会误拦所有人的提交
SECRET_KEYS=("storePassword" "keyPassword" "certpath" "storeFile")

# 只检查本次**暂存**的内容（工作区里没 add 的东西不该拦）
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
[ -z "$STAGED_FILES" ] && exit 0

fail=0
for f in "${TARGETS[@]}"; do
  case "$STAGED_FILES" in
    *"$f"*) ;;
    *) continue ;;
  esac

  hit=""
  for k in "${SECRET_KEYS[@]}"; do
    if git show ":$f" 2>/dev/null | grep -q -- "$k"; then
      hit="$k"
      break
    fi
  done
  [ -z "$hit" ] && continue

  fail=1
  echo "" >&2
  echo "拒绝提交：$f 的暂存内容里含签名材料（命中「$hit」）。" >&2
  echo "" >&2
  echo "该文件被 git 跟踪，DevEco 自动签名会把本机证书路径与口令写进它。" >&2
  echo "请把签名段挪出暂存区，只提交可移植部分（targetSdkVersion / compatibleSdkVersion 等）：" >&2
  echo "" >&2
  echo "    git restore --staged $f      # 取消暂存" >&2
  echo "" >&2
  echo "并把本机签名配置另存为（已被 .gitignore 忽略）：" >&2
  echo "    mobile/harmony/.local/build-profile.signing.json5" >&2
  echo "" >&2
  echo "当前暂存内容里的签名行：" >&2
  git show ":$f" 2>/dev/null | grep -nE "storePassword|keyPassword|certpath|storeFile" | sed 's/^/    /' >&2
  echo "" >&2
done

if [ "$fail" -eq 1 ]; then
  echo "若确认无误需要强行提交：git commit --no-verify" >&2
  exit 1
fi
exit 0
