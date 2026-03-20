#!/bin/bash
set -e

echo "=== Claude Code VSCode Extension - KaTeX LaTeX Patch ==="
echo ""

# Find the Claude Code extension directory
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
  echo "Searched in: ~/.vscode-server/extensions, ~/.vscode/extensions, ~/.cursor/extensions"
  echo ""
  echo "If your extension is elsewhere, run:"
  echo "  EXT_DIR=/path/to/anthropic.claude-code-x.x.x-linux-x64 bash install.sh"
  exit 1
fi

echo "Found extension: $EXT_DIR"
echo ""

# Check for existing patch
if grep -q "KaTeX LaTeX Rendering Patch" "$EXT_DIR/webview/index.js" 2>/dev/null; then
  echo "KaTeX patch is already applied. To reinstall, run uninstall.sh first."
  exit 0
fi

# Check for npm
if ! command -v npm &>/dev/null; then
  echo "ERROR: npm is required. Install Node.js first."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "[1/4] Downloading KaTeX..."
cd "$TEMP_DIR"
npm install katex --silent 2>/dev/null
echo "      Done."

echo "[2/4] Backing up original files..."
for f in webview/index.js webview/index.css; do
  if [ ! -f "$EXT_DIR/$f.bak" ]; then
    cp "$EXT_DIR/$f" "$EXT_DIR/$f.bak"
    echo "      Backed up $f"
  else
    echo "      Backup already exists for $f (skipping)"
  fi
done

echo "[3/4] Copying KaTeX fonts..."
cp -r "$TEMP_DIR/node_modules/katex/dist/fonts" "$EXT_DIR/webview/fonts"
echo "      Copied $(ls "$EXT_DIR/webview/fonts/" | wc -l) font files."

echo "[4/4] Patching webview..."

# Patch index.js: append KaTeX core + auto-render + MutationObserver
{
cat << 'MARKER'

/* === KaTeX LaTeX Rendering Patch === */
/* https://github.com/KaTeX/KaTeX - MIT License */
/* KaTeX Core */
MARKER
cat "$TEMP_DIR/node_modules/katex/dist/katex.min.js"
echo ""
echo "/* KaTeX Auto-Render Extension */"
cat "$TEMP_DIR/node_modules/katex/dist/contrib/auto-render.min.js"
echo ""
cat << 'MARKER'
/* KaTeX MutationObserver - post-processes rendered markdown to render LaTeX */
(function() {
  var renderTimeout = null;
  var isRendering = false;

  function renderMath() {
    if (isRendering) return;
    if (typeof renderMathInElement !== 'function') return;
    var root = document.getElementById('root');
    if (!root) return;

    isRendering = true;
    try {
      renderMathInElement(root, {
        delimiters: [
          {left: '$$', right: '$$', display: true},
          {left: '\\[', right: '\\]', display: true},
          {left: '\\(', right: '\\)', display: false},
          {left: '$', right: '$', display: false}
        ],
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
        ignoredClasses: ['katex', 'katex-display']
      });
    } catch(e) {
      console.error('[KaTeX Patch] render error:', e);
    } finally {
      isRendering = false;
    }
  }

  function debouncedRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(renderMath, 200);
  }

  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0 || mutations[i].type === 'characterData') {
        debouncedRender();
        return;
      }
    }
  });

  function startObserving() {
    var root = document.getElementById('root');
    if (root) {
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      renderMath();
    } else {
      setTimeout(startObserving, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }

  console.log('[KaTeX Patch] LaTeX rendering enabled');
})();
/* === End KaTeX Patch === */
MARKER
} >> "$EXT_DIR/webview/index.js"

# Patch index.css: append KaTeX stylesheet
{
echo ""
echo "/* === KaTeX LaTeX Rendering CSS Patch === */"
cat "$TEMP_DIR/node_modules/katex/dist/katex.min.css"
cat << 'MARKER'

.katex-display {
  margin: 0.5em 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.25em 0;
}
.katex-display > .katex {
  white-space: normal;
}
.katex {
  font-size: 1.1em;
}
/* === End KaTeX CSS Patch === */
MARKER
} >> "$EXT_DIR/webview/index.css"

echo ""
echo "=== Patch applied successfully! ==="
echo ""
echo "Reload your VSCode window to activate:"
echo "  Ctrl+Shift+P -> 'Developer: Reload Window'"
echo ""
echo "To uninstall, run: bash $(dirname "$0")/uninstall.sh"
echo ""
echo "NOTE: Extension updates will overwrite this patch. Re-run install.sh after updates."
