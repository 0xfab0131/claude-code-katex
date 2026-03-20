const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';

function findClaudeCodeExtDir() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    return ext.extensionPath;
  }
  return null;
}

function isPatched(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    return js.includes(PATCH_MARKER);
  } catch {
    return false;
  }
}

function applyPatch(extDir, vendorDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsPath = path.join(webviewDir, 'index.js');
  const cssPath = path.join(webviewDir, 'index.css');

  // Back up originals if not already backed up
  for (const f of [jsPath, cssPath]) {
    if (!fs.existsSync(f + '.katex-bak')) {
      fs.copyFileSync(f, f + '.katex-bak');
    }
  }

  // Copy fonts
  const fontsTarget = path.join(webviewDir, 'fonts');
  const fontsSrc = path.join(vendorDir, 'fonts');
  if (!fs.existsSync(fontsTarget)) {
    fs.mkdirSync(fontsTarget, { recursive: true });
  }
  for (const font of fs.readdirSync(fontsSrc)) {
    fs.copyFileSync(path.join(fontsSrc, font), path.join(fontsTarget, font));
  }

  // Patch index.js
  const katexCore = fs.readFileSync(path.join(vendorDir, 'katex.min.js'), 'utf8');
  const autoRender = fs.readFileSync(path.join(vendorDir, 'auto-render.min.js'), 'utf8');
  const observerScript = getMutationObserverScript();

  const jsPatch = `
${PATCH_MARKER}
/* KaTeX Core - MIT License - https://katex.org */
${katexCore}
/* KaTeX Auto-Render Extension */
${autoRender}
${observerScript}
/* === End KaTeX Patch === */`;

  fs.appendFileSync(jsPath, jsPatch);

  // Patch index.css
  const katexCss = fs.readFileSync(path.join(vendorDir, 'katex.min.css'), 'utf8');
  const cssPatch = `
${PATCH_CSS_MARKER}
${katexCss}
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
/* === End KaTeX CSS Patch === */`;

  fs.appendFileSync(cssPath, cssPatch);
}

function removePatch(extDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsPath = path.join(webviewDir, 'index.js');
  const cssPath = path.join(webviewDir, 'index.css');

  let restored = false;
  for (const f of [jsPath, cssPath]) {
    const bak = f + '.katex-bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      restored = true;
    }
  }

  const fontsDir = path.join(webviewDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true });
  }

  return restored;
}

function getMutationObserverScript() {
  return `
/* KaTeX MutationObserver - post-processes rendered markdown */
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
          {left: '\\\\[', right: '\\\\]', display: true},
          {left: '\\\\(', right: '\\\\)', display: false},
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
})();`;
}

function promptReload(message) {
  vscode.window.showInformationMessage(message, 'Reload Window').then(function(choice) {
    if (choice === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

function activate(context) {
  const vendorDir = path.join(context.extensionPath, 'vendor');

  // Auto-patch on startup
  const extDir = findClaudeCodeExtDir();
  if (extDir && !isPatched(extDir)) {
    try {
      applyPatch(extDir, vendorDir);
      promptReload('Claude Code KaTeX: LaTeX rendering patch applied. Reload to activate.');
    } catch (e) {
      console.error('[Claude Code KaTeX] Auto-patch failed:', e);
    }
  }

  // Enable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.enable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (isPatched(dir)) {
        vscode.window.showInformationMessage('KaTeX patch is already active.');
        return;
      }
      try {
        applyPatch(dir, vendorDir);
        promptReload('KaTeX patch applied. Reload to activate.');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to apply patch: ' + e.message);
      }
    })
  );

  // Disable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.disable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (!isPatched(dir)) {
        vscode.window.showInformationMessage('KaTeX patch is not active.');
        return;
      }
      try {
        removePatch(dir);
        promptReload('KaTeX patch removed. Reload to apply.');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to remove patch: ' + e.message);
      }
    })
  );

  // Status command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.status', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showInformationMessage('Claude Code extension not found.');
        return;
      }
      const patched = isPatched(dir);
      vscode.window.showInformationMessage(
        'Claude Code KaTeX: ' + (patched ? 'Active' : 'Not active') +
        '\nExtension: ' + dir
      );
    })
  );

  // Watch for Claude Code extension changes (updates)
  context.subscriptions.push(
    vscode.extensions.onDidChange(function() {
      const dir = findClaudeCodeExtDir();
      if (dir && !isPatched(dir)) {
        try {
          applyPatch(dir, vendorDir);
          promptReload('Claude Code was updated. KaTeX patch re-applied. Reload to activate.');
        } catch (e) {
          console.error('[Claude Code KaTeX] Re-patch after update failed:', e);
        }
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
