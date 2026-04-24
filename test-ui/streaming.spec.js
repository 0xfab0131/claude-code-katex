// @ts-check
// Faithful streaming reproduction for PR #3 "failsafe re-scan" claim.
//
// We simulate THREE distinct streaming DOM-mutation patterns (A/B/C) that
// a chat UI might use, load the actual patched KaTeX observer script, and
// assert that math renders in each case.
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9877;

function getObserverScript() {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...args);
  };
  require.cache['vscode'] = {
    id: 'vscode', filename: 'vscode', loaded: true,
    exports: {
      window: { showInformationMessage: () => Promise.resolve(), showErrorMessage: () => {} },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
      extensions: { getExtension: () => null, onDidChange: () => ({ dispose() {} }) },
    },
  };
  delete require.cache[require.resolve(path.join(ROOT, 'extension'))];
  const { _test } = require(path.join(ROOT, 'extension'));
  Module._resolveFilename = origResolve;
  return _test.getMutationObserverScript();
}

function createServer() {
  const patchScript = getObserverScript();

  return http.createServer((req, res) => {
    let filePath;
    if (req.url === '/') filePath = path.join(__dirname, 'streaming-harness.html');
    else filePath = path.join(ROOT, req.url);

    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    }[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found: ' + filePath); return; }
      let content = data;
      if (req.url === '/') {
        content = data.toString().replace('/* __PATCH_SCRIPT__ */', () => patchScript);
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    });
  });
}

let server;

test.beforeAll(async () => {
  server = createServer();
  await new Promise((r) => server.listen(PORT, r));
});

test.afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function readyPage(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__testReady === true, null, { timeout: 20000 });
  return errors;
}

const SAMPLE = 'Here is $x^2 + y^2 = z^2$ and $E = mc^2$.\n\n$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n\nAlso $\\alpha + \\beta$.';

test.describe('Pattern A: innerHTML replacement per token', () => {
  test('math renders after streaming completes', async ({ page }) => {
    const errors = await readyPage(page);
    await page.evaluate((t) => window.__streamA(t, 2, 30), SAMPLE);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'test-results/A-slow.png', fullPage: true });

    const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
    const display = await page.locator('[data-testid="assistant-message"] .katex-display').count();
    const rawText = await page.locator('[data-testid="assistant-message"]').textContent();
    console.log('A: katex=%d display=%d errors=%s text=%j', katex, display, errors.join('|'), rawText);
    expect(katex).toBeGreaterThanOrEqual(3); // 3 inline math expressions
    expect(display).toBeGreaterThanOrEqual(1);
  });

  test('math renders on a second streamed message', async ({ page }) => {
    await readyPage(page);
    await page.evaluate((t) => window.__streamA(t, 2, 25), 'First: $a + b = c$');
    await page.waitForTimeout(1200);
    await page.evaluate((t) => window.__streamA(t, 2, 25), 'Second: $x^2 = y$');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/A-second.png', fullPage: true });

    const msgs = page.locator('[data-testid="assistant-message"]');
    const count = await msgs.count();
    console.log('A second: msg count=', count);
    const lastKatex = await msgs.last().locator('.katex').count();
    expect(lastKatex).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Pattern B: textContent replacement per token', () => {
  test('math renders after streaming completes', async ({ page }) => {
    const errors = await readyPage(page);
    await page.evaluate((t) => window.__streamB(t, 2, 30), SAMPLE);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'test-results/B-slow.png', fullPage: true });

    const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
    const display = await page.locator('[data-testid="assistant-message"] .katex-display').count();
    console.log('B: katex=%d display=%d errors=%s', katex, display, errors.join('|'));
    expect(katex).toBeGreaterThanOrEqual(3);
    // Pattern B doesn't produce $$ display math because there's no paragraph split;
    // but the observer should still detect and render $$ inline.
  });
});

test.describe('Pattern C: appendChild new text nodes per token', () => {
  test('math renders after streaming completes', async ({ page }) => {
    const errors = await readyPage(page);
    await page.evaluate((t) => window.__streamC(t, 2, 30), SAMPLE);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'test-results/C-slow.png', fullPage: true });

    const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
    console.log('C: katex=', katex, 'errors=', errors.join('|'));
    expect(katex).toBeGreaterThanOrEqual(3);
  });
});

test.describe('Observer diagnostics', () => {
  test('capture observer mutation callback firings during pattern A', async ({ page }) => {
    await readyPage(page);
    // Instrument the MutationObserver to count calls
    await page.evaluate(() => {
      window.__observerFired = 0;
      window.__mutationCount = 0;
      const orig = MutationObserver;
      window.MutationObserver = function (cb) {
        const wrapped = (muts, obs) => {
          window.__observerFired++;
          window.__mutationCount += muts.length;
          return cb(muts, obs);
        };
        return new orig(wrapped);
      };
      Object.setPrototypeOf(window.MutationObserver, orig);
    });
    // Note: instrumentation must happen BEFORE the observer is set up, but the
    // KaTeX patch has already run. So this test is informational only — we can
    // still check the DOM state at the end.
    await page.evaluate((t) => window.__streamA(t, 2, 30), SAMPLE);
    await page.waitForTimeout(1200);

    const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
    console.log('[diag] katex rendered:', katex);
  });
});
