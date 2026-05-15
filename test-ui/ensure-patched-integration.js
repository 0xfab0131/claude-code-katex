/**
 * ensure-patched-integration.js  (manual, NOT a .spec.js)
 *
 * Exercises ensurePatched() against a REAL Claude Code webview bundle (~4.8 MB
 * minified) rather than the tiny jest fixture, to confirm the version-stamp /
 * stale-detection / restore-then-re-patch logic holds at real scale.
 *
 * Pure filesystem + node — no browser. Operates ONLY on the code-server test
 * instance (Instance B); a hard guard refuses the user's .vscode-server copy.
 * A pristine snapshot is taken up front and force-restored at the end, so the
 * test instance is left byte-identical to how it started no matter what.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT_DIR = '/teamspace/studios/this_studio/.local/share/code-server/extensions/anthropic.claude-code-2.1.142-linux-x64';
const WEBVIEW = path.join(EXT_DIR, 'webview');
const KATEX_REPO = '/teamspace/studios/this_studio/claude-code-katex';
const VENDOR = path.join(KATEX_REPO, 'vendor');

if (EXT_DIR.includes('.vscode-server') || !EXT_DIR.includes('.local/share/code-server')) {
  throw new Error('SAFETY ABORT: target is not the code-server test instance.');
}

// Load the real extension internals with a stub 'vscode'.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const _t = require(path.join(KATEX_REPO, 'extension.js'))._test;

const jsPath = path.join(WEBVIEW, 'index.js');
const cssPath = path.join(WEBVIEW, 'index.css');
const read = (p) => fs.readFileSync(p);
const readStr = (p) => fs.readFileSync(p, 'utf8');
const markerCount = () => readStr(jsPath).split(_t.PATCH_MARKER).length - 1;

function deleteArtifacts() {
  for (const f of ['index.js.katex-bak', 'index.css.katex-bak']) {
    const p = path.join(WEBVIEW, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const fonts = path.join(WEBVIEW, 'fonts');
  if (fs.existsSync(fonts)) fs.rmSync(fonts, { recursive: true, force: true });
}
function setStamp(version) {
  const stamp = _t.PATCH_VERSION_PREFIX + _t.EXTENSION_VERSION + ' */';
  let js = readStr(jsPath);
  js = version === null
    ? js.replace(stamp + '\n', '')
    : js.replace(stamp, _t.PATCH_VERSION_PREFIX + version + ' */');
  fs.writeFileSync(jsPath, js);
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}

// --- snapshot the pristine bundle so cleanup is guaranteed ---
deleteArtifacts();
if (_t.isPatched(EXT_DIR)) throw new Error('test instance is patched at start; aborting');
const snapJs = path.join(os.tmpdir(), 'cc-pristine-' + Date.now() + '.js');
const snapCss = path.join(os.tmpdir(), 'cc-pristine-' + Date.now() + '.css');
fs.copyFileSync(jsPath, snapJs);
fs.copyFileSync(cssPath, snapCss);
const pristineJs = read(jsPath);
console.log(`pristine index.js: ${pristineJs.length} bytes\n`);

try {
  // 1. fresh patch
  console.log('[1] ensurePatched on a pristine bundle');
  check('returns "fresh"', _t.ensurePatched(EXT_DIR, VENDOR) === 'fresh');
  check('isPatched true', _t.isPatched(EXT_DIR));
  check('version stamp == EXTENSION_VERSION', _t.getPatchedVersion(EXT_DIR) === _t.EXTENSION_VERSION);
  check('exactly one PATCH_MARKER', markerCount() === 1);
  check('fonts dir restored', fs.existsSync(path.join(WEBVIEW, 'fonts')));
  check('backups created', fs.existsSync(jsPath + '.katex-bak') && fs.existsSync(cssPath + '.katex-bak'));
  const freshJs = read(jsPath);
  const freshCss = read(cssPath);
  check('grew from pristine (patch appended)', freshJs.length > pristineJs.length);

  // 2. idempotent
  console.log('[2] ensurePatched again (already current)');
  check('returns "current"', _t.ensurePatched(EXT_DIR, VENDOR) === 'current');
  check('index.js byte-identical (untouched)', read(jsPath).equals(freshJs));

  // 3. stale older-version patch -> refresh
  console.log('[3] stale patch (stamp rewound to 0.0.1) -> refresh');
  setStamp('0.0.1');
  check('getPatchedVersion sees 0.0.1', _t.getPatchedVersion(EXT_DIR) === '0.0.1');
  check('returns "refreshed"', _t.ensurePatched(EXT_DIR, VENDOR) === 'refreshed');
  check('version stamp back to EXTENSION_VERSION', _t.getPatchedVersion(EXT_DIR) === _t.EXTENSION_VERSION);
  check('still exactly one PATCH_MARKER (no double-patch)', markerCount() === 1);
  check('refreshed index.js byte-identical to a fresh patch', read(jsPath).equals(freshJs));
  check('refreshed index.css byte-identical to a fresh patch', read(cssPath).equals(freshCss));

  // 4. legacy patch (no stamp at all) -> refresh
  console.log('[4] legacy patch (stamp stripped) -> refresh');
  setStamp(null);
  check('getPatchedVersion is null', _t.getPatchedVersion(EXT_DIR) === null);
  check('isPatched still true', _t.isPatched(EXT_DIR));
  check('returns "refreshed"', _t.ensurePatched(EXT_DIR, VENDOR) === 'refreshed');
  check('version stamp restored', _t.getPatchedVersion(EXT_DIR) === _t.EXTENSION_VERSION);
  check('one PATCH_MARKER, byte-identical to fresh', markerCount() === 1 && read(jsPath).equals(freshJs));

  // 5. stale but unsafe to refresh -> skipped, left untouched
  console.log('[5] stale patch with a missing backup -> skipped');
  setStamp('0.0.1');
  fs.unlinkSync(jsPath + '.katex-bak');
  const beforeSkip = read(jsPath);
  check('returns "skipped"', _t.ensurePatched(EXT_DIR, VENDOR) === 'skipped');
  check('index.js left untouched', read(jsPath).equals(beforeSkip));
  check('not double-patched', markerCount() === 1);
} finally {
  // --- force-restore the test instance to pristine ---
  fs.copyFileSync(snapJs, jsPath);
  fs.copyFileSync(snapCss, cssPath);
  deleteArtifacts();
  fs.unlinkSync(snapJs);
  fs.unlinkSync(snapCss);
  const ok = read(jsPath).equals(pristineJs) && !_t.isPatched(EXT_DIR)
    && !fs.existsSync(path.join(WEBVIEW, 'fonts'));
  console.log(`\ncleanup: test instance restored to pristine = ${ok ? 'yes' : 'NO (manual check needed)'}`);
  if (!ok) fail++;
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail === 0 ? 0 : 1);
