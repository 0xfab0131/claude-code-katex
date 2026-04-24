// @ts-check
// Faithful reproduction using REAL react-markdown (bundled via esbuild with
// a single React instance). This matches Claude Code's webview architecture
// — react-markdown with a custom <a> component that has event handlers.
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9881;

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

function createServer(htmlFile) {
  const INSTRUMENT = `
<script>
  window.__mutationLog = [];
  (function() {
    const Native = window.MutationObserver;
    window.MutationObserver = function(cb) {
      const wrapped = (muts, obs) => {
        for (const m of muts) {
          const added = [];
          for (let j = 0; j < m.addedNodes.length; j++) {
            const n = m.addedNodes[j];
            added.push(n.nodeType === 1 ? 'EL:' + n.tagName : (n.nodeType === 3 ? 'TEXT:' + JSON.stringify(String(n.nodeValue || '').slice(0, 40)) : 'n' + n.nodeType));
          }
          const removed = [];
          for (let j = 0; j < m.removedNodes.length; j++) {
            const n = m.removedNodes[j];
            removed.push(n.nodeType === 1 ? 'EL:' + n.tagName : (n.nodeType === 3 ? 'TEXT:' + JSON.stringify(String(n.nodeValue || '').slice(0, 40)) : 'n' + n.nodeType));
          }
          const t = m.target;
          window.__mutationLog.push({
            type: m.type,
            tgt: t && t.nodeType === 1 ? t.tagName : (t && t.nodeType === 3 ? 'TEXT:' + JSON.stringify(String(t.nodeValue || '').slice(0, 40)) : 'x'),
            added: added,
            removed: removed,
          });
        }
        return cb(muts, obs);
      };
      return new Native(wrapped);
    };
    Object.setPrototypeOf(window.MutationObserver, Native);
    window.MutationObserver.prototype = Native.prototype;
  })();
</script>`;

  const patchScript = getObserverScript();

  return http.createServer((req, res) => {
    let filePath;
    if (req.url === '/') filePath = path.join(__dirname, htmlFile);
    else filePath = path.join(ROOT, req.url);
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    }[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
      let content = data;
      if (req.url === '/') {
        let html = data.toString();
        html = html.replace('<head>', '<head>' + INSTRUMENT);
        html = html.replace('/* __PATCH_SCRIPT__ */', () => patchScript);
        content = html;
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    });
  });
}

let server;

test.beforeAll(async () => {
  server = createServer('react-streaming-harness.html');
  await new Promise((r) => server.listen(PORT, r));
});

test.afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function ready(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warn') errors.push(`[${msg.type()}] ${msg.text()}`);
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__reactReady === true, null, { timeout: 20000 });
  // Reset mutation log so we only capture streaming-era mutations.
  await page.evaluate(() => { window.__mutationLog = []; });
  return errors;
}

const SAMPLE = `Here is $x^2 + y^2 = z^2$ and $E = mc^2$.

Some display math: $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$

Also $\\alpha + \\beta$.`;

test('real react-markdown streaming (char-by-char)', async ({ page }) => {
  const errors = await ready(page);
  await page.evaluate((t) => window.__streamReact(t, 1, 15), SAMPLE);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/real-react-slow.png', fullPage: true });

  const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
  const display = await page.locator('[data-testid="assistant-message"] .katex-display').count();
  const log = await page.evaluate(() => window.__mutationLog);

  console.log('\n=== REAL react-markdown slow streaming ===');
  console.log('katex:', katex, 'display:', display);
  console.log('errors:', errors.join('\n'));
  console.log('mutation log sample (first 25, last 10 of', log.length, ' total):');
  log.slice(0, 25).forEach((m, i) => console.log('  #'+i, JSON.stringify(m)));
  console.log('  ...');
  log.slice(-10).forEach((m, i) => console.log('  #'+(log.length-10+i), JSON.stringify(m)));

  // Count mutation types
  const summary = {};
  for (const m of log) {
    const key = m.type + (m.added.length ? (':add=[' + m.added.map((s) => s.split(':')[0]).join(',') + ']') : '');
    summary[key] = (summary[key] || 0) + 1;
  }
  console.log('summary:', JSON.stringify(summary, null, 2));

  expect(katex).toBeGreaterThanOrEqual(3);
});

test('real react-markdown streaming (4-char chunks)', async ({ page }) => {
  await ready(page);
  await page.evaluate((t) => window.__streamReact(t, 4, 30), SAMPLE);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/real-react-chunks.png', fullPage: true });

  const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
  console.log('4-char chunks katex:', katex);
  expect(katex).toBeGreaterThanOrEqual(3);
});

test('real react-markdown streaming (word-sized chunks)', async ({ page }) => {
  await ready(page);
  await page.evaluate((t) => window.__streamReact(t, 8, 40), SAMPLE);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/real-react-words.png', fullPage: true });

  const katex = await page.locator('[data-testid="assistant-message"] .katex').count();
  console.log('word chunks katex:', katex);
  expect(katex).toBeGreaterThanOrEqual(3);
});
