#!/bin/bash
set -e

echo "=== Claude Code VSCode Extension - Remove KaTeX Patch ==="
echo ""

find_extension_dir() {
  local dirs=(
    "$HOME/.vscode-server/extensions"
    "$HOME/.vscode/extensions"
    "$HOME/.cursor/extensions"
    "/teamspace/studios/this_studio/.vscode-server/extensions"
  )
  for base in "${dirs[@]}"; do
    local match=$(ls -d "$base"/anthropic.claude-code-*/webview 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
    if [ -n "$match" ] && [ -d "$match" ]; then
      echo "$match"
      return 0
    fi
  done
  return 1
}

EXT_DIR=$(find_extension_dir)
if [ -z "$EXT_DIR" ]; then
  echo "ERROR: Could not find Claude Code extension directory."
  exit 1
fi

echo "Found extension: $EXT_DIR"

restored=0
for f in webview/index.js webview/index.css; do
  if [ -f "$EXT_DIR/$f.bak" ]; then
    cp "$EXT_DIR/$f.bak" "$EXT_DIR/$f"
    echo "Restored $f"
    restored=$((restored + 1))
  fi
done

if [ -d "$EXT_DIR/webview/fonts" ]; then
  rm -rf "$EXT_DIR/webview/fonts"
  echo "Removed KaTeX fonts"
fi

if [ "$restored" -eq 0 ]; then
  echo "No backups found. Patch may not have been installed."
else
  echo ""
  echo "=== Patch removed. Reload VSCode window to apply. ==="
fi
