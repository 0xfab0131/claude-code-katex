/**
 * reload-pickup-test.js  (manual, NOT a .spec.js — Playwright runner ignores it)
 *
 * Question under test:
 *   When the katex extension patches Claude Code's webview/index.js ON DISK
 *   *after* the webview has already loaded the unpatched bundle, does
 *   `workbench.action.webview.reloadWebviewAction` ("Developer: Reload
 *   Webviews") make the webview re-fetch and execute the PATCHED file?
 *   Or does it serve a stale/cached bundle so a full window reload is needed?
 *
 * SAFETY: this script ONLY touches Instance B — the code-server web instance
 * (~/.local/share/code-server/extensions/...). It asserts the target path is
 * NOT under .vscode-server (the instance the user is actively using).
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
const PATCH_MARKER = '=== KaTeX LaTeX Rendering Patch ===';
const CONSOLE_MARKER = '[KaTeX Patch] LaTeX rendering enabled';
const RESULTS = path.join(KATEX_REPO, 'test-results');

// ---- HARD SAFETY GUARD: never touch the user's instance ----
if (EXT_DIR.includes('.vscode-server')) {
  throw new Error('SAFETY ABORT: target is under .vscode-server (the instance the user is using).');
}
if (!EXT_DIR.includes('.local/share/code-server')) {
  throw new Error('SAFETY ABORT: target is not the code-server test instance.');
}

// ---- load the REAL patch logic from the extension (mock 'vscode') ----
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const ext = require(path.join(KATEX_REPO, 'extension.js'));
const { applyPatch, removePatch, isPatched } = ext._test;

function fullClean() {
  try { removePatch(EXT_DIR); } catch (_) {}
  for (const f of ['index.js', 'index.css']) {
    const bak = path.join(CC_WEBVIEW, f + '.katex-bak');
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  }
  const fonts = path.join(CC_WEBVIEW, 'fonts');
  if (fs.existsSync(fonts)) fs.rmSync(fonts, { recursive: true, force: true });
}
function jsSize() { return fs.statSync(path.join(CC_WEBVIEW, 'index.js')).size; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open the command palette, type `cmd`, and CONFIRM the top quick-pick row
// actually matches `expect` before pressing Enter. Retries if it doesn't.
async function openCommand(page, cmd, expect) {
  expect = (expect || cmd).toLowerCase();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Control+Shift+P');
    await sleep(900);
    // ensure the palette opened
    const widget = page.locator('.quick-input-widget');
    if (!(await widget.isVisible().catch(() => false))) { await sleep(600); continue; }
    await page.keyboard.type(cmd, { delay: 22 });
    await sleep(1100);
    let top = '';
    try { top = (await page.locator('.quick-input-widget .monaco-list-row').first().innerText({ timeout: 2500 })).toLowerCase(); } catch (_) {}
    if (top.includes(expect)) {
      await page.keyboard.press('Enter');
      return true;
    }
    console.log(`    openCommand("${cmd}") attempt ${attempt}: top row was "${top.replace(/\n/g, ' ').slice(0, 60)}" — retrying`);
  }
  await page.keyboard.press('Escape');
  return false;
}

async function getClaudeFrame(page, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        if (await f.locator('#root').count()) return f;
      } catch (_) {}
    }
    await sleep(1000);
  }
  return null;
}

// Poll until the tagged iframe is gone/replaced (proves a webview reload happened).
async function waitIframeTornDown(page, stamp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await getClaudeFrame(page, 2000);
    if (f) {
      let s = '__detached__';
      try { s = await f.evaluate(() => window.__reloadTestStamp || null); }
      catch (_) { return true; }
      if (s !== stamp) return true;
    }
    await sleep(1000);
  }
  return false;
}

// Wait until the Claude Code app is fully interactive (not just #root present).
async function waitForClaudeReady(page, timeoutMs = 80000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await getClaudeFrame(page, 3000);
    if (f) {
      try {
        const ready = await f.evaluate(() => {
          const hasInput = !!document.querySelector('[aria-label="Message input"], [contenteditable="true"], textarea');
          const root = document.querySelector('#root');
          return hasInput && root && root.innerText.trim().length > 0;
        });
        if (ready) return f;
      } catch (_) {}
    }
    await sleep(1500);
  }
  return await getClaudeFrame(page, 2000);
}

async function probe(frame) {
  return await frame.evaluate(async (marker) => {
    const out = {
      katexGlobal: typeof window.katex,
      renderFn: typeof window.renderMathInElement,
      preStamp: window.__reloadTestStamp || null,
    };
    const scripts = [...document.scripts].filter((s) => s.src);
    out.scriptCount = scripts.length;
    const script = scripts.find((s) => /index\.js/.test(s.src)) || scripts[scripts.length - 1];
    out.scriptSrc = script ? script.src : null;
    if (script) {
      try {
        const txt = await fetch(script.src).then((r) => r.text());
        out.servedLen = txt.length;
        out.servedHasPatch = txt.includes(marker);
      } catch (e) {
        out.fetchErr = String(e);
      }
    }
    return out;
  }, PATCH_MARKER);
}

async function runTest(mode) {
  console.log(`\n${'='.repeat(70)}\n  TEST: ${mode === 'webview' ? 'Developer: Reload Webviews' : 'Developer: Reload Window'}\n${'='.repeat(70)}`);
  fullClean();
  console.log(`  on-disk index.js: ${jsSize()} bytes, patched=${isPatched(EXT_DIR)} (clean baseline)`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const consoleLog = [];
  page.on('console', (m) => consoleLog.push({ t: Date.now(), url: (m.location() || {}).url || '', text: m.text() }));
  page.on('pageerror', (e) => consoleLog.push({ t: Date.now(), url: 'pageerror', text: String(e) }));

  const result = { mode };
  try {
    await page.goto(`${CODE_SERVER}/?folder=${FOLDER}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(9000);
    if (!(await openCommand(page, 'Claude Code: Open in New Tab', 'open in new tab')))
      throw new Error('could not invoke "Claude Code: Open in New Tab"');

    const f1 = await waitForClaudeReady(page);
    if (!f1) throw new Error('Claude Code webview never became ready (initial open)');
    const before = await probe(f1);
    console.log(`  [before patch] katexGlobal=${before.katexGlobal} renderFn=${before.renderFn} servedHasPatch=${before.servedHasPatch}`);
    result.before = before;

    // tag the live iframe so we can prove it actually got torn down on reload
    const stamp = 'STAMP_' + Date.now();
    await f1.evaluate((s) => { window.__reloadTestStamp = s; }, stamp);

    // patch ON DISK while the webview is already open & running the unpatched JS
    applyPatch(EXT_DIR, VENDOR);
    console.log(`  [patched on disk] index.js now ${jsSize()} bytes, patched=${isPatched(EXT_DIR)}`);
    await page.screenshot({ path: path.join(RESULTS, `reload-${mode}-1-before-reload.png`) });

    const fireTime = Date.now();
    let reloadHappened = false;

    if (mode === 'webview') {
      for (let attempt = 1; attempt <= 2 && !reloadHappened; attempt++) {
        if (!(await openCommand(page, 'Developer: Reload Webviews', 'reload webviews')))
          throw new Error('could not invoke "Developer: Reload Webviews"');
        reloadHappened = await waitIframeTornDown(page, stamp, 30000);
        if (!reloadHappened) console.log(`    iframe not torn down (attempt ${attempt})`);
      }
    } else {
      for (let attempt = 1; attempt <= 2 && !reloadHappened; attempt++) {
        const loadEvt = page.waitForEvent('load', { timeout: 35000 }).then(() => true).catch(() => false);
        if (!(await openCommand(page, 'Developer: Reload Window', 'reload window')))
          throw new Error('could not invoke "Developer: Reload Window"');
        reloadHappened = await loadEvt;
        if (!reloadHappened) console.log(`    window did not reload (attempt ${attempt})`);
      }
      await sleep(9000); // workbench + extension host re-init
    }
    result.reloadCommandTookEffect = reloadHappened;
    if (!reloadHappened) throw new Error(`reload command ("${mode}") never took effect`);

    let f2 = await waitForClaudeReady(page, 60000);
    if (!f2 && mode === 'window') {
      result.reopenedAfterWindowReload = true;
      await openCommand(page, 'Claude Code: Open in New Tab', 'open in new tab');
      f2 = await waitForClaudeReady(page, 60000);
    }
    if (!f2) throw new Error('Claude Code webview never became ready (after reload)');

    await sleep(4000); // let the (large) patched bundle finish executing
    const after = await probe(f2);
    result.after = after;
    result.iframeWasTornDown = after.preStamp !== stamp;

    const postConsole = consoleLog.filter((c) => c.t >= fireTime);
    result.consoleMarkerSeen = postConsole.some((c) => c.text.includes(CONSOLE_MARKER));
    result.postConsoleSample = postConsole.slice(0, 12).map((c) => c.text.slice(0, 100));

    await page.screenshot({ path: path.join(RESULTS, `reload-${mode}-2-after-reload.png`) });

    console.log(`  [after reload] reloadTookEffect=${reloadHappened} iframeTornDown=${result.iframeWasTornDown} katexGlobal=${after.katexGlobal} renderFn=${after.renderFn}`);
    console.log(`  [after reload] console "${CONSOLE_MARKER}" seen=${result.consoleMarkerSeen}`);

    const patchExecuted = (after.katexGlobal !== 'undefined') || result.consoleMarkerSeen;
    result.verdict = patchExecuted
      ? 'PICKED UP — webview is running the patched bundle'
      : 'STALE — webview still running the unpatched bundle';
    result.patchExecuted = patchExecuted;
  } catch (e) {
    result.error = String(e && e.stack || e);
    console.log('  ERROR: ' + result.error);
    try { await page.screenshot({ path: path.join(RESULTS, `reload-${mode}-ERROR.png`) }); } catch (_) {}
  } finally {
    await browser.close();
    fullClean();
    console.log(`  cleaned up. index.js back to ${jsSize()} bytes, patched=${isPatched(EXT_DIR)}`);
  }
  return result;
}

(async () => {
  if (!fs.existsSync(RESULTS)) fs.mkdirSync(RESULTS, { recursive: true });
  const webview = await runTest('webview');
  const win = await runTest('window');

  console.log(`\n${'#'.repeat(70)}\n#  SUMMARY\n${'#'.repeat(70)}`);
  for (const r of [webview, win]) {
    const label = r.mode === 'webview' ? 'Reload Webviews' : 'Reload Window  ';
    if (r.error) { console.log(`  ${label} : ERROR — ${r.error.split('\n')[0]}`); continue; }
    console.log(`  ${label} : ${r.verdict}`);
    console.log(`        iframeTornDown=${r.iframeWasTornDown}  katexGlobal=${r.after.katexGlobal}  servedHasPatch=${r.after.servedHasPatch}  consoleMarker=${r.consoleMarkerSeen}`);
    if (r.reopenedAfterWindowReload) console.log('        (note: editor tab not auto-restored; reopened manually)');
  }
  fs.writeFileSync(path.join(RESULTS, 'reload-pickup-result.json'), JSON.stringify({ webview, win }, null, 2));
  console.log(`\n  full JSON -> ${path.join(RESULTS, 'reload-pickup-result.json')}`);
})();
