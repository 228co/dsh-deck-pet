#!/usr/bin/env bash
# 开发用：本地构建后推到 Deck 上并重启 Decky Loader
# 用法：DECK=deck@steamdeck.local bash scripts/deploy-dev.sh
set -euo pipefail

cd "$(dirname "$0")/.."
DECK="${DECK:-deck@steamdeck.local}"
PLUGIN_DIR="$(basename "$(pwd)")"

pnpm run build

echo "==> rsync -> $DECK:~/homebrew/plugins/$PLUGIN_DIR/"
rsync -av --delete \
  --exclude node_modules --exclude out --exclude .git \
  ./ "$DECK:~/homebrew/plugins/$PLUGIN_DIR/"

echo "==> 重启 plugin_loader"
ssh "$DECK" 'echo deck | sudo -S systemctl restart plugin_loader' || \
  ssh "$DECK" 'sudo systemctl restart plugin_loader'

echo "==> 最近日志"
ssh "$DECK" "ls -t ~/homebrew/logs/$PLUGIN_DIR/*.log 2>/dev/null | head -n1 | xargs -r tail -n 40"
