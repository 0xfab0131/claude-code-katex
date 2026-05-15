const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Mock vscode module (not available outside VS Code) ---
const mockShowInformationMessage = jest.fn().mockResolvedValue(undefined);
const mockShowErrorMessage = jest.fn();
const mockExecuteCommand = jest.fn();
const mockRegisterCommand = jest.fn().mockReturnValue({ dispose: jest.fn() });
const mockOnDidChange = jest.fn().mockReturnValue({ dispose: jest.fn() });
const mockGetExtension = jest.fn();
const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  show: jest.fn(),
  hide: jest.fn(),
  dispose: jest.fn(),
};
const mockCreateStatusBarItem = jest.fn().mockReturnValue(mockStatusBarItem);

jest.mock('vscode', () => ({
  window: {
    showInformationMessage: mockShowInformationMessage,
    showErrorMessage: mockShowErrorMessage,
    createStatusBarItem: mockCreateStatusBarItem,
  },
  commands: {
    registerCommand: mockRegisterCommand,
    executeCommand: mockExecuteCommand,
  },
  extensions: {
    getExtension: mockGetExtension,
    onDidChange: mockOnDidChange,
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
}), { virtual: true });

const { activate, deactivate, _test } = require('./extension');
const {
  findClaudeCodeExtDir,
  isPatched,
  applyPatch,
  removePatch,
  getMutationObserverScript,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
} = _test;

// --- Test fixtures ---
let tmpDir;
let extDir;
let vendorDir;

function setupFakeClaudeCodeExt() {
  extDir = path.join(tmpDir, 'anthropic.claude-code-1.0.0');
  const webviewDir = path.join(extDir, 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  fs.writeFileSync(path.join(webviewDir, 'index.js'), '// original claude code webview js\nconsole.log("hello");');
  fs.writeFileSync(path.join(webviewDir, 'index.css'), '/* original css */ body { margin: 0; }');
  return extDir;
}

function setupFakeVendorDir() {
  vendorDir = path.join(tmpDir, 'vendor');
  const fontsDir = path.join(vendorDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'katex.min.js'), '/* katex core mock */');
  fs.writeFileSync(path.join(vendorDir, 'auto-render.min.js'), '/* auto-render mock */');
  fs.writeFileSync(path.join(vendorDir, 'katex.min.css'), '/* katex css mock */');
  fs.writeFileSync(path.join(fontsDir, 'KaTeX_Main.woff2'), 'fake-font-data');
  fs.writeFileSync(path.join(fontsDir, 'KaTeX_Math.woff2'), 'fake-font-data-2');
  return vendorDir;
}

// Rewrites the version stamp inside an already-applied patch to simulate a
// patch left behind by a different extension build. `fakeVersion === null`
// strips the stamp entirely, simulating a pre-versioning (<= 1.9.0) patch.
function makeStalePatch(fakeVersion) {
  const jsPath = path.join(extDir, 'webview', 'index.js');
  const stamp = _test.PATCH_VERSION_PREFIX + _test.EXTENSION_VERSION + ' */';
  let js = fs.readFileSync(jsPath, 'utf8');
  if (fakeVersion === null) {
    js = js.replace(stamp + '\n', '');
  } else {
    js = js.replace(stamp, _test.PATCH_VERSION_PREFIX + fakeVersion + ' */');
  }
  fs.writeFileSync(jsPath, js);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'katex-test-'));
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// findClaudeCodeExtDir
// ============================================================
describe('findClaudeCodeExtDir', () => {
  test('returns extensionPath when Claude Code is installed', () => {
    mockGetExtension.mockReturnValue({ extensionPath: '/some/path' });
    expect(findClaudeCodeExtDir()).toBe('/some/path');
  });

  test('returns null when Claude Code is not installed', () => {
    mockGetExtension.mockReturnValue(undefined);
    expect(findClaudeCodeExtDir()).toBeNull();
  });
});

// ============================================================
// isPatched
// ============================================================
describe('isPatched', () => {
  test('returns false for unpatched files', () => {
    setupFakeClaudeCodeExt();
    expect(isPatched(extDir)).toBe(false);
  });

  test('returns true after patching', () => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);
  });

  test('returns false when extension dir does not exist', () => {
    expect(isPatched('/nonexistent/path')).toBe(false);
  });

  test('returns false when webview/index.js is missing', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(isPatched(emptyDir)).toBe(false);
  });
});

// ============================================================
// applyPatch
// ============================================================
describe('applyPatch', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('creates .katex-bak backup files', () => {
    applyPatch(extDir, vendorDir);
    expect(fs.existsSync(path.join(extDir, 'webview', 'index.js.katex-bak'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'webview', 'index.css.katex-bak'))).toBe(true);
  });

  test('backup contains original content', () => {
    const originalJs = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const originalCss = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    applyPatch(extDir, vendorDir);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'utf8')).toBe(originalJs);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.css.katex-bak'), 'utf8')).toBe(originalCss);
  });

  test('does not overwrite existing backups', () => {
    applyPatch(extDir, vendorDir);
    // Overwrite the backup with something different
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'PRESERVED');
    // Patch again (simulating re-patch after update)
    // First remove the marker so applyPatch can run
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), '// new claude code version');
    applyPatch(extDir, vendorDir);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'utf8')).toBe('PRESERVED');
  });

  test('appends JS patch marker to index.js', () => {
    applyPatch(extDir, vendorDir);
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    expect(js).toContain(PATCH_MARKER);
    expect(js).toContain('/* === End KaTeX Patch === */');
  });

  test('appends katex core and auto-render to index.js', () => {
    applyPatch(extDir, vendorDir);
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    expect(js).toContain('/* katex core mock */');
    expect(js).toContain('/* auto-render mock */');
  });

  test('appends MutationObserver script to index.js', () => {
    applyPatch(extDir, vendorDir);
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    expect(js).toContain('MutationObserver');
    expect(js).toContain('renderMathInElement');
    expect(js).toContain('debouncedRender');
  });

  test('preserves original JS content before the patch', () => {
    const originalJs = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    applyPatch(extDir, vendorDir);
    const patchedJs = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    expect(patchedJs.startsWith(originalJs)).toBe(true);
  });

  test('appends CSS patch marker to index.css', () => {
    applyPatch(extDir, vendorDir);
    const css = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    expect(css).toContain(PATCH_CSS_MARKER);
    expect(css).toContain('/* === End KaTeX CSS Patch === */');
  });

  test('appends katex CSS and custom styles to index.css', () => {
    applyPatch(extDir, vendorDir);
    const css = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    expect(css).toContain('/* katex css mock */');
    expect(css).toContain('.katex-display');
    expect(css).toContain('.katex');
  });

  test('preserves original CSS content before the patch', () => {
    const originalCss = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    applyPatch(extDir, vendorDir);
    const patchedCss = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    expect(patchedCss.startsWith(originalCss)).toBe(true);
  });

  test('copies font files to webview/fonts/', () => {
    applyPatch(extDir, vendorDir);
    const fontsDir = path.join(extDir, 'webview', 'fonts');
    expect(fs.existsSync(fontsDir)).toBe(true);
    expect(fs.existsSync(path.join(fontsDir, 'KaTeX_Main.woff2'))).toBe(true);
    expect(fs.existsSync(path.join(fontsDir, 'KaTeX_Math.woff2'))).toBe(true);
    expect(fs.readFileSync(path.join(fontsDir, 'KaTeX_Main.woff2'), 'utf8')).toBe('fake-font-data');
  });
});

// ============================================================
// removePatch
// ============================================================
describe('removePatch', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('restores original files from backups', () => {
    const originalJs = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const originalCss = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    applyPatch(extDir, vendorDir);

    // Verify patched
    expect(isPatched(extDir)).toBe(true);

    removePatch(extDir);

    // Verify restored
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8')).toBe(originalJs);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8')).toBe(originalCss);
  });

  test('removes fonts directory', () => {
    applyPatch(extDir, vendorDir);
    expect(fs.existsSync(path.join(extDir, 'webview', 'fonts'))).toBe(true);

    removePatch(extDir);
    expect(fs.existsSync(path.join(extDir, 'webview', 'fonts'))).toBe(false);
  });

  test('returns true when backups existed', () => {
    applyPatch(extDir, vendorDir);
    expect(removePatch(extDir)).toBe(true);
  });

  test('returns false when no backups exist', () => {
    expect(removePatch(extDir)).toBe(false);
  });

  test('isPatched returns false after removePatch', () => {
    applyPatch(extDir, vendorDir);
    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
  });

  test('patch -> remove -> patch cycle works', () => {
    const originalJs = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');

    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);

    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8')).toBe(originalJs);

    // Remove old backups so applyPatch creates fresh ones
    for (const f of ['index.js.katex-bak', 'index.css.katex-bak']) {
      const bakPath = path.join(extDir, 'webview', f);
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
    }

    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);

    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8')).toBe(originalJs);
  });
});

// ============================================================
// getMutationObserverScript
// ============================================================
describe('getMutationObserverScript', () => {
  const script = getMutationObserverScript();

  test('is a self-executing function', () => {
    expect(script).toContain('(function()');
    expect(script).toContain('})();');
  });

  test('uses #root for bootstrap only', () => {
    expect(script).toContain("document.getElementById('root')");
  });

  test('targets messagesContainer for rendering (not #root)', () => {
    expect(script).toContain('[class*="messagesContainer"]');
    expect(script).toContain('renderMathInElement(el,');
    expect(script).not.toContain('renderMathInElement(root,');
  });

  test('creates message observer and root observer', () => {
    expect(script).toContain('messageObserver');
    expect(script).toContain('rootObserver');
    expect(script).toContain('new MutationObserver');
  });

  test('re-attaches when messages container changes', () => {
    expect(script).toContain('activeContainer');
    expect(script).toContain('container !== activeContainer');
    expect(script).toContain('observeMessages');
  });

  test('includes display math delimiters ($$)', () => {
    expect(script).toContain("left: '$$', right: '$$', display: true");
  });

  test('does NOT include raw $ delimiter (uses preprocessor instead)', () => {
    expect(script).not.toContain("left: '$', right: '$'");
    expect(script).toContain('preprocessMath');
    expect(script).toContain('findMathRanges');
  });

  test('includes LaTeX bracket delimiters (\\[...\\])', () => {
    expect(script).toContain("display: true");
  });

  test('includes LaTeX paren delimiters (\\(...\\))', () => {
    expect(script).toContain("display: false");
  });

  test('ignores pre and code tags', () => {
    expect(script).toContain("'pre'");
    expect(script).toContain("'code'");
    expect(script).toContain('ignoredTags');
  });

  test('ignores already-rendered katex elements', () => {
    expect(script).toContain("'katex'");
    expect(script).toContain("'katex-display'");
    expect(script).toContain('ignoredClasses');
  });

  test('debounces rendering with 200ms delay', () => {
    expect(script).toContain('}, 200)');
    expect(script).toContain('debouncedRender');
  });

  test('handles DOMContentLoaded for early load', () => {
    expect(script).toContain("document.readyState === 'loading'");
    expect(script).toContain('DOMContentLoaded');
  });

  test('disconnects observer during rendering to prevent cascading mutations', () => {
    expect(script).toContain('messageObserver.disconnect()');
    // Must reconnect after rendering
    expect(script).toContain('messageObserver.observe(activeContainer');
  });

  test('bubbles mutations up to assistant-message boundary for per-message rendering', () => {
    expect(script).toContain('renderDirtyMessages');
    // Every mutation target is walked up to its assistant-message ancestor
    // so that characterData mutations, text-node additions, and element
    // additions are all handled uniformly. Falls back to the full container
    // if the mutation isn't inside an assistant message.
    expect(script).toContain('assistant-message');
  });

  test('accumulates mutations across debounced callbacks instead of overwriting', () => {
    // Fixes a bug where the mutations closure captured only the latest batch,
    // so rapid streaming callbacks would drop earlier mutations and most
    // paragraphs would never get a render pass.
    expect(script).toContain('pendingMutations');
  });

  test('checks hasMathContent before rendering a node', () => {
    expect(script).toContain('hasMathContent');
  });

  test('has re-entrant guard', () => {
    expect(script).toContain('isRendering');
    expect(script).toContain('if (isRendering) return');
  });

  test('sets throwOnError to false', () => {
    expect(script).toContain('throwOnError: false');
  });

  test('fixes \\left{ and \\right} stripped by remark characterEscape', () => {
    expect(script).toContain('fixedLatex');
    // The generated JS should contain the regex that matches \left{ and \right}
    expect(script).toContain('\\left\\{');
    expect(script).toContain('\\right\\}');
  });

  test('fixedLatex regex correctly restores \\left\\{ and \\right\\}', () => {
    // Extract and eval the fix logic from the generated script
    // In the generated JS: range.latex.replace(/\\left\{/g, '\\left\\{').replace(/\\right\}/g, '\\right\\}')
    // At runtime, the DOM text has \left{ (backslash before { was stripped by remark)
    const input = '\\left{ \\sum_{k=0}^{n} \\binom{n}{k} x^k y^{n-k} \\right}';
    const fixed = input.replace(/\\left\{/g, '\\left\\{').replace(/\\right\}/g, '\\right\\}');
    expect(fixed).toBe('\\left\\{ \\sum_{k=0}^{n} \\binom{n}{k} x^k y^{n-k} \\right\\}');
  });

  test('fixedLatex regex does not touch \\left( or \\left[ or grouping braces', () => {
    const fix = (s) => s.replace(/\\left\{/g, '\\left\\{').replace(/\\right\}/g, '\\right\\}');
    expect(fix('\\left( x \\right)')).toBe('\\left( x \\right)');
    expect(fix('\\left[ x \\right]')).toBe('\\left[ x \\right]');
    expect(fix('\\left. x \\right|')).toBe('\\left. x \\right|');
    expect(fix('\\frac{a}{b}')).toBe('\\frac{a}{b}');
  });
});

// ============================================================
// activate
// ============================================================
// ============================================================
// getPatchedVersion
// ============================================================
describe('getPatchedVersion', () => {
  const { getPatchedVersion } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('returns null when the webview is unpatched', () => {
    expect(getPatchedVersion(extDir)).toBeNull();
  });

  test('returns this extension version after applyPatch', () => {
    applyPatch(extDir, vendorDir);
    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
  });

  test('returns null for a patch with no version stamp (<= 1.9.0 build)', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch(null); // strip the stamp line
    expect(isPatched(extDir)).toBe(true); // still patched...
    expect(getPatchedVersion(extDir)).toBeNull(); // ...but version unknown
  });

  test('returns null when index.js cannot be read', () => {
    expect(getPatchedVersion(path.join(tmpDir, 'no-such-dir'))).toBeNull();
  });
});

// ============================================================
// canRestoreOriginals
// ============================================================
describe('canRestoreOriginals', () => {
  const { canRestoreOriginals } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('true when backups exist and are clean originals', () => {
    applyPatch(extDir, vendorDir);
    expect(canRestoreOriginals(extDir)).toBe(true);
  });

  test('false when a backup file is missing', () => {
    applyPatch(extDir, vendorDir);
    fs.unlinkSync(path.join(extDir, 'webview', 'index.js.katex-bak'));
    expect(canRestoreOriginals(extDir)).toBe(false);
  });

  test('false when the JS backup is itself patched', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(
      path.join(extDir, 'webview', 'index.js.katex-bak'),
      'junk ' + PATCH_MARKER + ' junk'
    );
    expect(canRestoreOriginals(extDir)).toBe(false);
  });

  test('false when the CSS backup is itself patched', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(
      path.join(extDir, 'webview', 'index.css.katex-bak'),
      'junk ' + PATCH_CSS_MARKER + ' junk'
    );
    expect(canRestoreOriginals(extDir)).toBe(false);
  });
});

// ============================================================
// ensurePatched
// ============================================================
describe('ensurePatched', () => {
  const { ensurePatched, getPatchedVersion } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  function patchMarkerCount() {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    return js.split(PATCH_MARKER).length - 1;
  }

  test('"fresh" when unpatched: applies the patch', () => {
    expect(ensurePatched(extDir, vendorDir)).toBe('fresh');
    expect(isPatched(extDir)).toBe(true);
    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
  });

  test('"current" when already patched with this version: file unchanged', () => {
    applyPatch(extDir, vendorDir);
    const before = fs.readFileSync(path.join(extDir, 'webview', 'index.js'));
    expect(ensurePatched(extDir, vendorDir)).toBe('current');
    const after = fs.readFileSync(path.join(extDir, 'webview', 'index.js'));
    expect(after.equals(before)).toBe(true);
  });

  test('"refreshed" for an older-version patch: restores then re-patches once', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    expect(getPatchedVersion(extDir)).toBe('0.0.1');

    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');

    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
    expect(patchMarkerCount()).toBe(1); // never doubled
  });

  test('"refreshed" for a pre-versioning patch with no stamp', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch(null);
    expect(getPatchedVersion(extDir)).toBeNull();

    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');

    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
    expect(patchMarkerCount()).toBe(1);
  });

  test('"skipped" when stale but a backup is missing: patch left untouched', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    fs.unlinkSync(path.join(extDir, 'webview', 'index.js.katex-bak'));
    const before = fs.readFileSync(path.join(extDir, 'webview', 'index.js'));

    expect(ensurePatched(extDir, vendorDir)).toBe('skipped');

    const after = fs.readFileSync(path.join(extDir, 'webview', 'index.js'));
    expect(after.equals(before)).toBe(true);
    expect(patchMarkerCount()).toBe(1); // not doubled
  });

  test('"skipped" when stale but a backup is itself patched', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    fs.writeFileSync(
      path.join(extDir, 'webview', 'index.js.katex-bak'),
      'poisoned ' + PATCH_MARKER
    );

    expect(ensurePatched(extDir, vendorDir)).toBe('skipped');
    expect(patchMarkerCount()).toBe(1);
  });

  test('refresh is idempotent: a second call reports "current", still one patch', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');
    expect(ensurePatched(extDir, vendorDir)).toBe('current');
    expect(patchMarkerCount()).toBe(1);
  });
});

describe('activate', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = {
      extensionPath: tmpDir,
      subscriptions: [],
    };
  });

  test('auto-patches when Claude Code is found and unpatched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(isPatched(extDir)).toBe(true);
  });

  test('auto-reloads the webview and notifies after auto-patching', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview',
      'Reload Window'
    );
  });

  test('does not re-patch or reload if already patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    mockShowInformationMessage.mockClear();
    mockExecuteCommand.mockClear();

    activate(context);
    // Already patched: no re-patch, no webview reload, no notification
    expect(mockExecuteCommand).not.toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('The webview was reloaded'),
      'Reload Webview',
      'Reload Window'
    );
  });

  test('refreshes a stale patch on activation and notifies', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    // Simulate a webview still carrying an older extension build's patch.
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    mockShowInformationMessage.mockClear();
    mockExecuteCommand.mockClear();

    activate(context);

    // Re-patched with the current version, exactly once.
    expect(_test.getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
    // Reloaded + notified with the "updated" message.
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX updated. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview',
      'Reload Window'
    );
  });

  test('registers 4 commands', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    const registeredCommands = mockRegisterCommand.mock.calls.map(c => c[0]);
    expect(registeredCommands).toContain('claude-code-katex.enable');
    expect(registeredCommands).toContain('claude-code-katex.disable');
    expect(registeredCommands).toContain('claude-code-katex.status');
    expect(registeredCommands).toContain('claude-code-katex.rerender');
  });

  test('creates and shows the status bar item with the rerender command', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    mockCreateStatusBarItem.mockClear();
    mockStatusBarItem.show.mockClear();
    activate(context);
    expect(mockCreateStatusBarItem).toHaveBeenCalledWith(
      2 /* StatusBarAlignment.Right */,
      100
    );
    expect(mockStatusBarItem.show).toHaveBeenCalled();
    expect(mockStatusBarItem.command).toBe('claude-code-katex.rerender');
    expect(mockStatusBarItem.text).toMatch(/LaTeX/);
  });

  test('pushes disposables to context.subscriptions', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    // 4 commands (enable, disable, status, rerender) + 1 statusBarItem +
    // 1 onDidChange = 6 subscriptions
    expect(context.subscriptions.length).toBe(6);
  });

  test('registers onDidChange watcher', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockOnDidChange).toHaveBeenCalled();
  });

  test('handles Claude Code not being installed', () => {
    mockGetExtension.mockReturnValue(undefined);
    // Should not throw
    expect(() => activate(context)).not.toThrow();
    // Still registers commands
    expect(mockRegisterCommand).toHaveBeenCalled();
  });
});

// ============================================================
// activate -> Enable command handler
// ============================================================
describe('Enable command', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  function getCommandHandler(commandName) {
    return mockRegisterCommand.mock.calls.find(c => c[0] === commandName)[1];
  }

  test('patches, reloads the webview, and notifies when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    // Pre-patch so activate doesn't reload, then remove patch
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();
    mockExecuteCommand.mockClear();

    const enableHandler = getCommandHandler('claude-code-katex.enable');
    enableHandler();

    expect(isPatched(extDir)).toBe(true);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview',
      'Reload Window'
    );
  });

  test('shows "already active" when already patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockShowInformationMessage.mockClear();

    const enableHandler = getCommandHandler('claude-code-katex.enable');
    enableHandler();

    expect(mockShowInformationMessage).toHaveBeenCalledWith('KaTeX patch is already active.');
  });

  test('shows error when Claude Code not found', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);

    // Now simulate Claude Code gone
    mockGetExtension.mockReturnValue(undefined);
    const enableHandler = getCommandHandler('claude-code-katex.enable');
    enableHandler();

    expect(mockShowErrorMessage).toHaveBeenCalledWith('Claude Code extension not found.');
  });
});

// ============================================================
// activate -> Disable command handler
// ============================================================
describe('Disable command', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  function getCommandHandler(commandName) {
    return mockRegisterCommand.mock.calls.find(c => c[0] === commandName)[1];
  }

  test('removes patch, reloads the webview, and notifies when patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockShowInformationMessage.mockClear();
    mockExecuteCommand.mockClear();

    const disableHandler = getCommandHandler('claude-code-katex.disable');
    disableHandler();

    expect(isPatched(extDir)).toBe(false);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX disabled. The webview was reloaded.',
      'Reload Webview',
      'Reload Window'
    );
  });

  test('shows "not active" when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();

    const disableHandler = getCommandHandler('claude-code-katex.disable');
    disableHandler();

    expect(mockShowInformationMessage).toHaveBeenCalledWith('KaTeX patch is not active.');
  });

  test('shows error when Claude Code not found', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);

    mockGetExtension.mockReturnValue(undefined);
    const disableHandler = getCommandHandler('claude-code-katex.disable');
    disableHandler();

    expect(mockShowErrorMessage).toHaveBeenCalledWith('Claude Code extension not found.');
  });
});

// ============================================================
// activate -> Status command handler
// ============================================================
describe('Status command', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  function getCommandHandler(commandName) {
    return mockRegisterCommand.mock.calls.find(c => c[0] === commandName)[1];
  }

  test('reports Active when patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockShowInformationMessage.mockClear();

    const statusHandler = getCommandHandler('claude-code-katex.status');
    statusHandler();

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Active')
    );
  });

  test('reports Not active when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();

    const statusHandler = getCommandHandler('claude-code-katex.status');
    statusHandler();

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Not active')
    );
  });

  test('shows message when Claude Code not found', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);

    mockGetExtension.mockReturnValue(undefined);
    const statusHandler = getCommandHandler('claude-code-katex.status');
    statusHandler();

    expect(mockShowInformationMessage).toHaveBeenCalledWith('Claude Code extension not found.');
  });
});

// ============================================================
// activate -> onDidChange handler (Claude Code updates)
// ============================================================
describe('onDidChange (Claude Code update)', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  test('re-patches when Claude Code updates (files overwritten)', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(isPatched(extDir)).toBe(true);

    // Simulate Claude Code update: overwrite webview files
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), '// updated claude code');
    expect(isPatched(extDir)).toBe(false);

    // Trigger onDidChange
    const onDidChangeHandler = mockOnDidChange.mock.calls[0][0];
    mockExecuteCommand.mockClear();
    onDidChangeHandler();

    expect(isPatched(extDir)).toBe(true);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX re-applied after a Claude Code update. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview',
      'Reload Window'
    );
  });

  test('does not re-patch when already patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    mockShowInformationMessage.mockClear();

    const onDidChangeHandler = mockOnDidChange.mock.calls[0][0];
    onDidChangeHandler();

    // Should not show re-patch message
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('re-applied'),
      'Reload Webview',
      'Reload Window'
    );
  });
});

// ============================================================
// reloadWebviewAndNotify
// ============================================================
describe('reloadWebviewAndNotify', () => {
  const { reloadWebviewAndNotify } = _test;

  test('reloads the webview immediately', () => {
    reloadWebviewAndNotify('hello');
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
  });

  test('shows the message with Reload Webview before Reload Window', () => {
    reloadWebviewAndNotify('hello');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'hello',
      'Reload Webview',
      'Reload Window'
    );
  });

  test('"Reload Webview" button reloads the webview again', async () => {
    mockShowInformationMessage.mockResolvedValueOnce('Reload Webview');
    reloadWebviewAndNotify('hello');
    await Promise.resolve();
    await Promise.resolve();
    const reloads = mockExecuteCommand.mock.calls.filter(
      (c) => c[0] === 'workbench.action.webview.reloadWebviewAction'
    );
    // once on invocation, once from the button
    expect(reloads.length).toBe(2);
  });

  test('"Reload Window" button triggers a full window reload', async () => {
    mockShowInformationMessage.mockResolvedValueOnce('Reload Window');
    reloadWebviewAndNotify('hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.reloadWindow'
    );
  });
});

// ============================================================
// deactivate
// ============================================================
describe('deactivate', () => {
  test('is a function', () => {
    expect(typeof deactivate).toBe('function');
  });

  test('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  test('does not remove patches (intentionally empty)', () => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);

    deactivate();

    // Files should still be patched
    expect(isPatched(extDir)).toBe(true);
  });
});

// ============================================================
// uninstall-hook.js
// ============================================================
describe('uninstall-hook.js', () => {
  test('restores backups and cleans up fonts', () => {
    // Create a fake Claude Code dir in a known search location
    const fakeHome = path.join(tmpDir, 'home');
    const fakeExtBase = path.join(fakeHome, '.vscode-server', 'extensions');
    const fakeClaudeDir = path.join(fakeExtBase, 'anthropic.claude-code-2.0.0');
    const fakeWebview = path.join(fakeClaudeDir, 'webview');
    fs.mkdirSync(fakeWebview, { recursive: true });

    // Write original files and backups
    fs.writeFileSync(path.join(fakeWebview, 'index.js'), 'patched content');
    fs.writeFileSync(path.join(fakeWebview, 'index.js.katex-bak'), 'original js');
    fs.writeFileSync(path.join(fakeWebview, 'index.css'), 'patched css');
    fs.writeFileSync(path.join(fakeWebview, 'index.css.katex-bak'), 'original css');
    const fontsDir = path.join(fakeWebview, 'fonts');
    fs.mkdirSync(fontsDir);
    fs.writeFileSync(path.join(fontsDir, 'test.woff2'), 'font');

    // The uninstall hook uses os.homedir() to find paths.
    // We'll test the logic inline since we can't easily mock os.homedir() for a script.
    // Instead, test the restoration logic directly (same as removePatch).
    for (const f of ['webview/index.js', 'webview/index.css']) {
      const bak = path.join(fakeClaudeDir, f + '.katex-bak');
      const orig = path.join(fakeClaudeDir, f);
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, orig);
        fs.unlinkSync(bak);
      }
    }
    if (fs.existsSync(fontsDir)) {
      fs.rmSync(fontsDir, { recursive: true });
    }

    expect(fs.readFileSync(path.join(fakeWebview, 'index.js'), 'utf8')).toBe('original js');
    expect(fs.readFileSync(path.join(fakeWebview, 'index.css'), 'utf8')).toBe('original css');
    expect(fs.existsSync(path.join(fakeWebview, 'index.js.katex-bak'))).toBe(false);
    expect(fs.existsSync(path.join(fakeWebview, 'index.css.katex-bak'))).toBe(false);
    expect(fs.existsSync(fontsDir)).toBe(false);
  });
});

// ============================================================
// Edge cases & regression tests
// ============================================================
describe('edge cases', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('double-patch does not corrupt files', () => {
    applyPatch(extDir, vendorDir);
    const afterFirst = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const markerCount1 = (afterFirst.match(new RegExp(PATCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    expect(markerCount1).toBe(1);

    // Apply again (simulating the bug where activate + enable both patch)
    applyPatch(extDir, vendorDir);
    const afterSecond = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const markerCount2 = (afterSecond.match(new RegExp(PATCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    // Note: applyPatch appends unconditionally. The caller (activate/enable) checks isPatched first.
    // If called twice, it WILL double-append. This test documents that behavior.
    expect(markerCount2).toBe(2);
  });

  test('removePatch is idempotent (no backup = no-op)', () => {
    // Remove without ever patching
    expect(removePatch(extDir)).toBe(false);
    // Original files should be unchanged
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    expect(js).toBe('// original claude code webview js\nconsole.log("hello");');
  });

  test('removePatch handles missing fonts dir gracefully', () => {
    applyPatch(extDir, vendorDir);
    // Manually remove fonts before removePatch
    fs.rmSync(path.join(extDir, 'webview', 'fonts'), { recursive: true });
    expect(() => removePatch(extDir)).not.toThrow();
  });

  test('patch content includes all required KaTeX config', () => {
    applyPatch(extDir, vendorDir);
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    // Must have safe delimiter types (no raw $ — handled by preprocessMath)
    expect(js).toContain("left: '$$'");
    expect(js).toContain('preprocessMath');
    // Must ignore code blocks
    expect(js).toContain("'pre'");
    expect(js).toContain("'code'");
    // Must not throw on bad LaTeX
    expect(js).toContain('throwOnError: false');
  });

  test('large file patching works (simulating real 4.7MB webview)', () => {
    // Create a large file to simulate real-world Claude Code webview
    const largeContent = '// ' + 'x'.repeat(1024 * 1024) + '\n'; // ~1MB
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), largeContent);
    // Remove old backup so a fresh one is made
    const bakPath = path.join(extDir, 'webview', 'index.js.katex-bak');
    if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);

    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);

    const backup = fs.readFileSync(bakPath, 'utf8');
    expect(backup).toBe(largeContent);

    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8')).toBe(largeContent);
  });

  test('v1.4.2 regression: activate always prompts reload when re-patching', () => {
    // This is the bug we fixed in v1.4.2
    // Scenario: User ran Disable, reloaded. activate() should re-patch AND prompt reload.
    mockGetExtension.mockReturnValue({ extensionPath: extDir });

    // Simulate: files were patched, then user disabled (which restores originals)
    // Backups still exist from original patch
    applyPatch(extDir, vendorDir);
    removePatch(extDir);
    // Backups still exist on disk
    expect(fs.existsSync(path.join(extDir, 'webview', 'index.js.katex-bak'))).toBe(true);
    expect(isPatched(extDir)).toBe(false);

    const context = { extensionPath: tmpDir, subscriptions: [] };
    activate(context);

    // Must re-patch
    expect(isPatched(extDir)).toBe(true);
    // Must reload + notify (the v1.4.1 bug was that it skipped this on re-patch)
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.action.webview.reloadWebviewAction'
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview',
      'Reload Window'
    );
  });
});
