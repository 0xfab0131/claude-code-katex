/**
 * reload-disable-test.js  (manual, NOT a .spec.js)
 *
 * Companion to reload-pickup-test.js. That one proved a webview reload picks up
 * a freshly-APPLIED patch. This proves the reverse: after `removePatch()`
 * restores the original on-disk index.js, a webview reload makes the webview
 * drop the patch (KaTeX gone) — i.e. the `disable` path works with a webview
 * reload, no window reload needed.
 *
 * SAFETY: touches ONLY the code-server test instance (Instance B).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CODE_SERVER = 'http://127.0.0.1:30110';
const FOLDER = '/teamspace/studios/this_studio';
const EXT_DIR = '/teamspace/studios/this_studio/.local/share/code-server/extensions/anthropic.claude-code-2.1.142-linux-x64';
const CC_WEBVIEW = path.join(EXT_DIR, 'webview');
const KATEX_REPO = '/teamspace/studios/this_studio/claude-code-katex';
const VENDOR = path.join(KATEX_REPO, 'vendor');
const CONSOLE_MARKER = '[KaTeX Patch] LaTeX rendering enabled';

if (EXT_DIR.includes('.vscode-server') || !EXT_DIR.includes('.local/share/code-server')) {
  throw new Error('SAFETY ABORT: target is not the code-server test instance.');
}

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { applyPatch, removePatch, isPatched } = require(path.join(KATEX_REPO, 'extension.js'))._test;

function fullClean() {
  try { removePatch(EXT_DIR); } catch (_) {}
  for (const f of ['index.js', 'index.css']) {
    const bak = path.join(CC_WEBVIEW, f + '.katex-bak');
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  }
  const fonts = path.join(CC_WEBVIEW, 'fonts');
  if (fs.existsSync(fonts)) fs.rmSync(fonts, { recursive: true, force: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openCommand(page, cmd, expect) {
  expect = expect.toLowerCase();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Control+Shift+P');
    await sleep(900);
    if (!(await page.locator('.quick-input-widget').isVisible().catch(() => false))) { await sleep(600); continue; }
    await page.keyboard.type(cmd, { delay: 22 });
    await sleep(1100);
    let top = '';
    try { top = (await page.locator('.quick-input-widget .monaco-list-row').first().innerText({ timeout: 2500 })).toLowerCase(); } catch (_) {}
    if (top.includes(expect)) { await page.keyboard.press('Enter'); return true; }
  }
  await page.keyboard.press('Escape');
  return false;
}

async function getClaudeFrame(page, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try { if (await f.locator('#root').count()) return f; } catch (_) {}
    }
    await sleep(1000);
  }
  return null;
}
async function waitForClaudeReady(page, timeoutMs = 80000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await getClaudeFrame(page, 3000);
    if (f) {
      try {
        if (await f.evaluate(() => {
          const r = document.querySelector('#root');
          return !!document.querySelector('[aria-label="Message input"], [contenteditable="true"], textarea') && r && r.innerText.trim().length > 0;
        })) return f;
      } catch (_) {}
    }
    await sleep(1500);
  }
  return getClaudeFrame(page, 2000);
}
async function waitIframeTornDown(page, stamp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await getClaudeFrame(page, 2000);
    if (f) {
      let s = '__detached__';
      try { s = await f.evaluate(() => window.__reloadTestStamp || null); } catch (_) { return true; }
      if (s !== stamp) return true;
    }
    await sleep(1000);
  }
  return false;
}
const probe = (f) => f.evaluate(() => ({ katexGlobal: typeof window.katex, renderFn: typeof window.renderMathInElement }));

(async () => {
  console.log(`${'='.repeat(70)}\n  TEST: webview reload picks up a patch REMOVAL (disable path)\n${'='.repeat(70)}`);
  fullClean();
  applyPatch(EXT_DIR, VENDOR); // start PATCHED, as if the extension was enabled
  console.log(`  on-disk index.js patched=${isPatched(EXT_DIR)} (starting patched)`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const consoleLog = [];
  page.on('console', (m) => consoleLog.push({ t: Date.now(), text: m.text() }));
  const result = {};
  try {
    await page.goto(`${CODE_SERVER}/?folder=${FOLDER}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(9000);
    if (!(await openCommand(page, 'Claude Code: Open in New Tab', 'open in new tab'))) throw new Error('open CC failed');

    const f1 = await waitForClaudeReady(page);
    if (!f1) throw new Error('webview never ready');
    const before = await probe(f1);
    console.log(`  [before] katexGlobal=${before.katexGlobal} renderFn=${before.renderFn}  (expect: patched)`);
    result.before = before;

    const stamp = 'STAMP_' + Date.now();
    await f1.evaluate((s) => { window.__reloadTestStamp = s; }, stamp);

    removePatch(EXT_DIR); // <-- the `disable` action: restore the original file
    console.log(`  [removePatch] on-disk patched=${isPatched(EXT_DIR)} (restored to original)`);

    let tornDown = false;
    for (let a = 1; a <= 2 && !tornDown; a++) {
      if (!(await openCommand(page, 'Developer: Reload Webviews', 'reload webviews'))) throw new Error('reload cmd failed');
      tornDown = await waitIframeTornDown(page, stamp, 30000);
    }
    result.reloadTookEffect = tornDown;
    if (!tornDown) throw new Error('webview did not reload');

    const f2 = await waitForClaudeReady(page, 60000);
    if (!f2) throw new Error('webview never ready after reload');
    await sleep(4000);
    const after = await probe(f2);
    result.after = after;
    result.consoleMarkerAfter = consoleLog.some((c) => c.text.includes(CONSOLE_MARKER) && c.t > Date.now() - 70000);
    console.log(`  [after reload] katexGlobal=${after.katexGlobal} renderFn=${after.renderFn}  (expect: undefined)`);

    const patchGone = after.katexGlobal === 'undefined' && after.renderFn === 'undefined';
    result.verdict = patchGone
      ? 'PASS — webview reload dropped the patch; KaTeX gone without a window reload'
      : 'FAIL — KaTeX still present after disable + webview reload';
    console.log(`\n  ${result.verdict}`);
  } catch (e) {
    result.error = String(e && e.stack || e);
    console.log('  ERROR: ' + result.error);
  } finally {
    await browser.close();
    fullClean();
    console.log(`  cleaned up. on-disk patched=${isPatched(EXT_DIR)}`);
  }
})();
