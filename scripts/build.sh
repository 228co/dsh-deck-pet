#!/usr/bin/env bash
# 构建 Decky 插件 zip：前端 bundle + 后端 + 悬浮外壳 + 文档
# 产物：out/dsh-deck-pet.zip（顶层目录名 = 插件目录名）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NAME="$(basename "$ROOT")"
OUT="$ROOT/out"
STAGE="$OUT/$NAME"

echo "==> 构建前端 (rollup)"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install
  pnpm run build
else
  echo "!! 没找到 pnpm，请先装 pnpm（或直接用仓库里已构建好的 dist/）" >&2
  exit 1
fi

echo "==> 组装 zip 目录"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r dist main.py plugin.json package.json README.md LICENSE defaults overlay "$STAGE/"
# 悬浮外壳不需要 node_modules
rm -rf "$STAGE/overlay/node_modules"
chmod +x "$STAGE/main.py" 2>/dev/null || true

echo "==> 打 zip"
( cd "$OUT" && rm -f "$NAME.zip" && zip -qr "$NAME.zip" "$NAME" -x '*.DS_Store' -x '*/.git/*' )

echo "完成：$OUT/$NAME.zip"
unzip -l "$OUT/$NAME.zip" | head -n 20
