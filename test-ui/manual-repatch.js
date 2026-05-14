// Manually applies the patch from local source extension.js to the
// installed Claude Code webview.  Used when iterating on extension.js
// without restarting code-server (which would force-reload the extension
// host).
//
// Always restores from .katex-bak first, so the result is exactly what
// vsce package + install + activate would produce.

const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CC_EXT = process.env.CC_EXT_DIR ||
  '/teamspace/studios/this_studio/.local/share/code-server/extensions/anthropic.claude-code-2.1.141-linux-x64';
const VENDOR = path.join(ROOT, 'vendor');

function mockVscode() {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...args) {
    if (req === 'vscode') return 'vscode';
    return origResolve.call(this, req, ...args);
  };
  require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: {
      window: {
        showInformationMessage: () => Promise.resolve(),
        showErrorMessage: () => {},
        createStatusBarItem: () => ({
          text: '',
          tooltip: '',
          command: '',
          show() {},
          hide() {},
          dispose() {},
        }),
      },
      commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: () => {},
      },
      extensions: {
        getExtension: () => null,
        onDidChange: () => ({ dispose() {} }),
      },
      StatusBarAlignment: { Left: 1, Right: 2 },
    },
  };
}

mockVscode();
const ext = require(path.join(ROOT, 'extension'));
const { applyPatch, isPatched } = ext._test;

// Restore from backup
const wv = path.join(CC_EXT, 'webview');
for (const f of ['index.js', 'index.css']) {
  const bak = path.join(wv, f + '.katex-bak');
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, path.join(wv, f));
  }
}
console.log('restored from .katex-bak');
console.log('isPatched before:', isPatched(CC_EXT));

applyPatch(CC_EXT, VENDOR);
console.log('isPatched after:', isPatched(CC_EXT));

// Sanity: confirm the new keydown handler text made it into the file.
const idx = fs.readFileSync(path.join(wv, 'index.js'), 'utf8');
console.log(
  'has keydown handler:',
  idx.includes('Manual re-render trigger: Ctrl+Alt+M')
);
console.log(
  'has bridge:',
  idx.includes('__claudeCodeKatexRerender')
);
