// Tests for the v2 patch path: injecting the remark-math pipeline into
// Claude Code's react-markdown call, and falling back to the v1 DOM
// post-processor when the injection point is absent.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

jest.mock('vscode', () => ({
  window: {},
  commands: { registerCommand: jest.fn(), executeCommand: jest.fn() },
  extensions: { getExtension: jest.fn(), onDidChange: jest.fn() },
  StatusBarAlignment: { Left: 1, Right: 2 },
}), { virtual: true });

const { _test } = require('./extension');
const VENDOR = path.join(__dirname, 'vendor');

// A minimal stand-in for Claude Code's webview bundle that carries the real
// react-markdown call shape: createElement(<Markdown>,{remarkPlugins:[<gfm>],
// components:{...}},<text>).
const FIXTURE_WITH = 'var a=1;' +
  'var el=B8.default.createElement(Co,{remarkPlugins:[yf],components:{a:1,pre:2}},Y);' +
  'console.log(el);';
const FIXTURE_WITHOUT = 'var a=1;var el=B8.default.createElement(Co,{components:{a:1}},Y);';

function makeExtDir(jsBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-'));
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'webview', 'index.js'), jsBody);
  fs.writeFileSync(path.join(dir, 'webview', 'index.css'), '/* cc css */');
  return dir;
}
const readJs = (d) => fs.readFileSync(path.join(d, 'webview', 'index.js'), 'utf8');
const isValidJs = (code) => { try { new vm.Script(code); return true; } catch { return false; } };

describe('v2 injection regex', () => {
  test('matches the real react-markdown call shape', () => {
    expect(_test.V2_INJECT_RE.test('B8.default.createElement(Co,{remarkPlugins:[yf],components:{}})')).toBe(true);
  });
  test('matches a multi-plugin list', () => {
    expect(_test.V2_INJECT_RE.test('createElement(M,{remarkPlugins:[gfm,foo]}')).toBe(true);
  });
  test('does not match an unrelated createElement call', () => {
    expect(_test.V2_INJECT_RE.test('createElement("div",{className:"x"})')).toBe(false);
  });
});

describe('applyPatch — v2 path', () => {
  let dir, pristineJs, pristineCss;
  beforeEach(() => { dir = makeExtDir(FIXTURE_WITH); pristineJs = readJs(dir); pristineCss = fs.readFileSync(path.join(dir,'webview','index.css'),'utf8'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('returns "v2" when the injection point is present', () => {
    expect(_test.applyPatch(dir, VENDOR)).toBe('v2');
  });
  test('stamps version and mode', () => {
    _test.applyPatch(dir, VENDOR);
    expect(_test.isPatched(dir)).toBe(true);
    expect(_test.getPatchedVersion(dir)).toBe(_test.EXTENSION_VERSION);
    expect(_test.getPatchedMode(dir)).toBe('v2');
  });
  test('injects guarded plugin references into the call', () => {
    _test.applyPatch(dir, VENDOR);
    const js = readJs(dir);
    expect(js).toContain('rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[]');
    expect(js).toContain('[yf].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])');
    expect(js).not.toContain('{remarkPlugins:[yf],components:'); // original consumed
  });
  test('bundles the remark-math pipeline', () => {
    _test.applyPatch(dir, VENDOR);
    expect(readJs(dir)).toContain('__KATEX_V2_LOADED');
  });
  test('the patched bundle is still syntactically valid JavaScript', () => {
    _test.applyPatch(dir, VENDOR);
    expect(isValidJs(readJs(dir))).toBe(true);
  });
  test('copies KaTeX fonts and patches CSS', () => {
    _test.applyPatch(dir, VENDOR);
    expect(fs.readdirSync(path.join(dir, 'webview', 'fonts')).length).toBeGreaterThan(50);
    expect(fs.readFileSync(path.join(dir, 'webview', 'index.css'), 'utf8')).toContain('.katex-display');
  });
  test('removePatch restores index.js / index.css byte-identically', () => {
    _test.applyPatch(dir, VENDOR);
    _test.removePatch(dir);
    expect(readJs(dir)).toBe(pristineJs);
    expect(fs.readFileSync(path.join(dir, 'webview', 'index.css'), 'utf8')).toBe(pristineCss);
    expect(fs.existsSync(path.join(dir, 'webview', 'fonts'))).toBe(false);
  });
});

describe('applyPatch — v1 fallback path', () => {
  let dir;
  beforeEach(() => { dir = makeExtDir(FIXTURE_WITHOUT); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('returns "v1-fallback" when the injection point is absent', () => {
    expect(_test.applyPatch(dir, VENDOR)).toBe('v1-fallback');
  });
  test('stamps mode v1-fallback and installs the DOM observer', () => {
    _test.applyPatch(dir, VENDOR);
    expect(_test.getPatchedMode(dir)).toBe('v1-fallback');
    expect(readJs(dir)).toContain('renderMathInElement');
  });
  test('the fallback-patched bundle is still valid JavaScript', () => {
    _test.applyPatch(dir, VENDOR);
    expect(isValidJs(readJs(dir))).toBe(true);
  });
});

// Opportunistic: if a real Claude Code bundle is on disk, patch a copy of it
// and confirm the injection still produces valid JS against the real shape.
describe('applyPatch — against the real Claude Code bundle (if present)', () => {
  const candidates = (() => {
    const base = path.join(os.homedir(), '.vscode-server', 'extensions');
    try {
      return fs.readdirSync(base)
        .filter((d) => d.startsWith('anthropic.claude-code-'))
        .map((d) => path.join(base, d, 'webview', 'index.js'))
        .filter((p) => fs.existsSync(p));
    } catch { return []; }
  })();

  (candidates.length ? test : test.skip)('patches a real bundle copy to valid v2 JS', () => {
    const real = fs.readFileSync(candidates[candidates.length - 1], 'utf8');
    const dir = makeExtDir(real);
    try {
      expect(_test.applyPatch(dir, VENDOR)).toBe('v2');
      expect(isValidJs(readJs(dir))).toBe(true);
      _test.removePatch(dir);
      expect(readJs(dir)).toBe(real);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
