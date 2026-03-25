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
  var activeContainer = null;
  var SELECTOR = '[class*="messagesContainer"]';

  // Convert $...$ to \\(...\\) only when the content looks like math, not currency.
  // This runs before renderMathInElement so we can use only unambiguous delimiters.
  //
  // Uses Pandoc's well-tested tex_math_dollars rules:
  // 1. Opening $ must be followed by a non-space character
  // 2. Closing $ must be preceded by a non-space character
  // 3. Closing $ must NOT be followed immediately by a digit
  //
  // This handles all cases with a single regex:
  // - $x^2$, $3x + 2y$, $3 + 4 = 7$ -> math (rules 1+2 pass, rule 3 OK)
  // - $100, $2.50, $50k -> no closing $ -> no match
  // - $100 and $200 -> closing preceded by space -> rule 2 fails
  // - $50,$30,$20 -> each closing $ followed by digit -> rule 3 fails
  var MATH_REGEX = /(?<![\\\\$])\\$(?!\\$)(?=\\S)([^$\\n]+?)(?<=\\S)\\$(?!\\d)(?!\\$)/g;
  var IGNORED_TAGS = {SCRIPT:1,NOSCRIPT:1,STYLE:1,TEXTAREA:1,PRE:1,CODE:1,OPTION:1};

  function preprocessMath(container) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var text = node.textContent;
      if (text.indexOf('$') === -1) continue;
      // Skip nodes inside already-rendered KaTeX or ignored tags
      var parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest && parent.closest('.katex,.katex-display')) continue;
      if (IGNORED_TAGS[parent.tagName]) continue;

      MATH_REGEX.lastIndex = 0;
      var replaced = text.replace(MATH_REGEX, '\\\\($1\\\\)');
      if (replaced !== text) {
        node.textContent = replaced;
      }
    }
  }

  function renderMath() {
    if (isRendering) return;
    if (typeof renderMathInElement !== 'function') return;
    var container = document.querySelector(SELECTOR);
    if (!container) return;

    isRendering = true;
    try {
      preprocessMath(container);
      renderMathInElement(container, {
        delimiters: [
          {left: '$$', right: '$$', display: true},
          {left: '\\\\[', right: '\\\\]', display: true},
          {left: '\\\\(', right: '\\\\)', display: false}
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

  var messageObserver = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0 || mutations[i].type === 'characterData') {
        debouncedRender();
        return;
      }
    }
  });

  function observeMessages(container) {
    if (activeContainer === container) return;
    if (activeContainer) messageObserver.disconnect();
    activeContainer = container;
    messageObserver.observe(container, { childList: true, subtree: true, characterData: true });
    renderMath();
  }

  // Lightweight root watcher: detects when the messages container appears
  // or is replaced (e.g. navigating between chats). Only watches childList
  // (no characterData), so typing in the input never triggers this.
  var rootObserver = new MutationObserver(function() {
    var container = document.querySelector(SELECTOR);
    if (container && container !== activeContainer) {
      observeMessages(container);
    }
  });

  function startObserving() {
    var root = document.getElementById('root');
    if (!root) {
      setTimeout(startObserving, 200);
      return;
    }
    rootObserver.observe(root, { childList: true, subtree: true });
    var container = document.querySelector(SELECTOR);
    if (container) {
      observeMessages(container);
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

  // Auto-patch on startup.
  // Files stay patched on disk between sessions so the webview always loads
  // the patched version (Claude Code's webview loads before this extension).
  const extDir = findClaudeCodeExtDir();
  if (extDir) {
    if (!isPatched(extDir)) {
      try {
        applyPatch(extDir, vendorDir);
        // Always prompt reload when we patch on startup, because the webview
        // already loaded the unpatched files before this extension activated.
        promptReload('Claude Code KaTeX: LaTeX rendering patch applied. Reload to activate.');
      } catch (e) {
        console.error('[Claude Code KaTeX] Auto-patch failed:', e);
      }
    }
  } else {
    console.warn('[Claude Code KaTeX] Claude Code extension not found.');
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

function deactivate() {
  // Intentionally empty. Files stay patched on disk so Claude Code's webview
  // (which loads before our extension activates) always gets the patched version.
  // Cleanup happens via: "Disable" command, or uninstall-hook.js on uninstall.
}

module.exports = { activate, deactivate };

// Exposed for testing only
module.exports._test = {
  findClaudeCodeExtDir,
  isPatched,
  applyPatch,
  removePatch,
  getMutationObserverScript,
  promptReload,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
};
