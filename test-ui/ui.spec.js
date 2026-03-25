// @ts-check
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9876;

// Extract the observer script from extension.js at runtime,
// so the UI test always matches the actual shipped code.
// We mock the vscode module before requiring extension.js.
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
  const { _test } = require(path.join(ROOT, 'extension'));
  Module._resolveFilename = origResolve;
  return _test.getMutationObserverScript();
}

// Minimal static file server that serves vendor/ and test-ui/ files,
// and injects the real patch script into harness.html.
function createServer() {
  const patchScript = getObserverScript();

  return http.createServer((req, res) => {
    let filePath = path.join(ROOT, req.url);
    if (req.url === '/') filePath = path.join(__dirname, 'harness.html');

    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    };

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      let content = data;
      // Inject the real patch script into the harness.
      // Use a function replacement to avoid $ being treated as a special pattern.
      if (req.url === '/') {
        content = data.toString().replace(
          '/* __PATCH_SCRIPT__ */',
          () => patchScript
        );
      }

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    });
  });
}

let server;

test.beforeAll(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// Helper: wait for KaTeX debounce (200ms) + margin
const RENDER_WAIT = 400;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('KaTeX patch - initial rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  test('renders KaTeX elements in the messages container', async ({ page }) => {
    const count = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(count).toBeGreaterThanOrEqual(6);
  });

  test('renders display math blocks', async ({ page }) => {
    const count = await page.locator('[class*="messagesContainer"] .katex-display').count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('does NOT render KaTeX inside the input area', async ({ page }) => {
    const count = await page.locator('[class*="inputContainer"] .katex').count();
    expect(count).toBe(0);
  });

  test('input is still contenteditable', async ({ page }) => {
    const editable = await page.locator('#chat-input').getAttribute('contenteditable');
    expect(editable).toBe('true');
  });

  test('no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.reload();
    await page.waitForTimeout(RENDER_WAIT);
    expect(errors).toEqual([]);
  });
});

test.describe('KaTeX patch - input isolation (the bug fix)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  test('typing $ characters in input does not garble text', async ({ page }) => {
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('price is $100 and $200', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const text = await input.textContent();
    expect(text).toBe('price is $100 and $200');
  });

  test('typing \\ characters in input does not garble text', async ({ page }) => {
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('path\\to\\file and \\n', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const text = await input.textContent();
    expect(text).toBe('path\\to\\file and \\n');
  });

  test('typing mixed $ and \\ does not create KaTeX in input', async ({ page }) => {
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('$x^2$ and \\frac{1}{2}', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const katexInInput = await page.locator('[class*="inputContainer"] .katex').count();
    expect(katexInInput).toBe(0);

    const text = await input.textContent();
    expect(text).toBe('$x^2$ and \\frac{1}{2}');
  });

  test('typing in input does not trigger removeChild crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const input = page.locator('#chat-input');
    await input.click();
    // Rapid typing with lots of $ and \ to stress-test
    await input.pressSequentially('$$$\\\\$test$\\frac$\\$end', { delay: 10 });
    await page.waitForTimeout(RENDER_WAIT);

    expect(errors).toEqual([]);
  });

  test('messages math is unaffected after typing in input', async ({ page }) => {
    const beforeCount = await page.locator('[class*="messagesContainer"] .katex').count();

    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('$hello$ \\world', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const afterCount = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(afterCount).toBe(beforeCount);
  });
});

test.describe('KaTeX patch - dynamic messages (streaming)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  test('new message with math is auto-rendered', async ({ page }) => {
    const before = await page.locator('[class*="messagesContainer"] .katex').count();

    await page.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      const msg = document.createElement('div');
      msg.className = 'message_07S1Yg assistant';
      msg.innerHTML = `
        <div class="message-label">Claude</div>
        <div class="message-bubble">New: $E = mc^2$</div>
      `;
      container.appendChild(msg);
    });

    await page.waitForTimeout(RENDER_WAIT);
    const after = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(after).toBeGreaterThan(before);
  });

  test('new display math is auto-rendered', async ({ page }) => {
    const before = await page.locator('[class*="messagesContainer"] .katex-display').count();

    await page.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      const msg = document.createElement('div');
      msg.className = 'message_07S1Yg assistant';
      msg.innerHTML = `
        <div class="message-label">Claude</div>
        <div class="message-bubble">$$\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}$$</div>
      `;
      container.appendChild(msg);
    });

    await page.waitForTimeout(RENDER_WAIT);
    const after = await page.locator('[class*="messagesContainer"] .katex-display').count();
    expect(after).toBeGreaterThan(before);
  });
});

test.describe('KaTeX patch - chat navigation (container replacement)', () => {
  test('re-attaches observer when messages container is replaced', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    // Replace the entire messages container (simulates React re-mount on chat switch)
    await page.evaluate(() => {
      const chat = document.querySelector('[class*="chatContainer"]');
      const old = document.querySelector('[class*="messagesContainer"]');
      const next = document.createElement('div');
      next.className = 'messagesContainer_07S1Yg';
      next.innerHTML = `
        <div class="message_07S1Yg assistant">
          <div class="message-label">Claude</div>
          <div class="message-bubble">New chat: $a^2 + b^2 = c^2$ and $$e^x = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!}$$</div>
        </div>
      `;
      chat.replaceChild(next, old);
    });

    await page.waitForTimeout(RENDER_WAIT);

    const katex = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(katex).toBeGreaterThanOrEqual(2);

    const display = await page.locator('[class*="messagesContainer"] .katex-display').count();
    expect(display).toBeGreaterThanOrEqual(1);
  });

  test('input stays clean after chat navigation', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    // Type in input first
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('$keepme$', { delay: 20 });

    // Replace messages container
    await page.evaluate(() => {
      const chat = document.querySelector('[class*="chatContainer"]');
      const old = document.querySelector('[class*="messagesContainer"]');
      const next = document.createElement('div');
      next.className = 'messagesContainer_07S1Yg';
      next.innerHTML = '<div class="message_07S1Yg assistant"><div class="message-bubble">$x$</div></div>';
      chat.replaceChild(next, old);
    });

    await page.waitForTimeout(RENDER_WAIT);

    const inputKatex = await page.locator('[class*="inputContainer"] .katex').count();
    expect(inputKatex).toBe(0);

    const text = await input.textContent();
    expect(text).toBe('$keepme$');
  });
});

test.describe('KaTeX patch - selector robustness', () => {
  test('works with different CSS module hashes', async ({ page }) => {
    // Load the page then swap the class to a different hash (simulating a
    // different Claude Code version). The rootObserver should still find it.
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    await page.evaluate(() => {
      const chat = document.querySelector('[class*="chatContainer"]');
      const old = document.querySelector('[class*="messagesContainer"]');
      const next = document.createElement('div');
      // Different hash suffix than the original _07S1Yg
      next.className = 'messagesContainer_xY9zKw';
      next.innerHTML = '<div class="message_07S1Yg assistant"><div class="message-bubble">$\\pi \\approx 3.14$</div></div>';
      chat.replaceChild(next, old);
    });

    await page.waitForTimeout(RENDER_WAIT);

    const katex = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(katex).toBeGreaterThanOrEqual(1);
  });

  test('gracefully handles missing messages container', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Remove the messages container entirely
    await page.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      container.remove();
    });

    await page.waitForTimeout(RENDER_WAIT);
    expect(errors).toEqual([]);
  });
});
