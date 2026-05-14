// Real-VS Code E2E verification for the issue #6 rerender additions.
// Costs ZERO Claude API tokens — does not send any chat prompts.
//
// What it verifies:
//   1. After a window reload (which picks up the new extension.js),
//      the status bar shows the LaTeX indicator.
//   2. The command palette has "Claude Code LaTeX: Re-render Math".
//   3. The new observer script (with keydown handler + window bridge)
//      is what Claude Code's webview actually loads.
//   4. Pressing Ctrl+Alt+M inside the chat re-renders a synthetic
//      raw-$ message we inject directly into the DOM.
//
// Prereqs: run `node test-ui/manual-repatch.js` first to ensure the
// webview index.js contains the new observer code.  This script also
// re-deploys extension.js into the installed extension dir if changed.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';
const OUT = path.join(__dirname, '..', 'test-results', 'issue-6', 'e2e');
fs.mkdirSync(OUT, { recursive: true });

async function openCommand(page, cmd) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type(cmd, { delay: 12 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}

async function getClaudeFrame(page) {
  for (let i = 0; i < 40; i++) {
    for (const f of page.frames()) {
      try {
        const r = await f.locator('#root').count();
        const inp = await f.locator('[aria-label="Message input"]').count();
        if (r > 0 && inp > 0) return f;
      } catch (_) {}
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await ctx.newPage();

  const consoleLogs = [];
  const allLatexConsoleLogs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('KaTeX') || t.includes('katex')) consoleLogs.push(t);
    if (t.includes('Claude Code LaTeX')) allLatexConsoleLogs.push(t);
  });

  console.log('1) navigating to code-server...');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  console.log('2) reloading the window so the new extension.js loads...');
  await openCommand(page, 'Developer: Reload Window');
  await page.waitForTimeout(12000);
  // Belt and braces: explicitly restart the extension host too, in case
  // the window reload didn't (some code-server builds reuse it).
  await openCommand(page, 'Developer: Restart Extension Host');
  await page.waitForTimeout(8000);

  // Check the heartbeat file written at the top of activate().  If
  // present and recent, the NEW extension.js is what just ran.
  const heartbeatPath = '/tmp/claude-code-katex-heartbeat.json';
  try {
    const beat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    const ageMs = Date.now() - new Date(beat.ts).getTime();
    console.log(
      `   heartbeat: ts=${beat.ts} age=${Math.round(ageMs / 1000)}s marker=${beat.marker}`
    );
  } catch (e) {
    console.log(
      `   heartbeat: NOT FOUND at ${heartbeatPath} — extension host did NOT pick up new code`
    );
  }

  console.log('3) checking status bar for LaTeX indicator...');
  console.log(
    '   extension host console (Claude Code LaTeX lines):',
    allLatexConsoleLogs
  );
  // Walk the entire statusbar container, not just .statusbar-item children.
  const sbDump = await page.evaluate(() => {
    const sb = document.querySelector('.part.statusbar') ||
      document.querySelector('#workbench\\.parts\\.statusbar');
    if (!sb) return { error: 'no statusbar' };
    return {
      totalDescendants: sb.querySelectorAll('*').length,
      itemsWithAria: [...sb.querySelectorAll('[aria-label]')]
        .map((el) => ({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          id: el.id,
          ariaLabel: el.getAttribute('aria-label') || '',
          text: (el.textContent || '').slice(0, 100),
        }))
        .slice(0, 40),
      anyLatexElements: [...sb.querySelectorAll('*')]
        .filter((el) => /latex/i.test(el.textContent || ''))
        .slice(0, 5)
        .map((el) => ({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          text: (el.textContent || '').slice(0, 100),
        })),
    };
  });
  console.log('   status bar dump:', JSON.stringify(sbDump, null, 2));
  const hasLatexIndicator =
    sbDump.anyLatexElements && sbDump.anyLatexElements.length > 0;
  console.log('   has LaTeX indicator:', hasLatexIndicator);
  await page.screenshot({ path: path.join(OUT, '01-after-reload.png') });

  console.log('4) checking command palette for rerender command...');
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type('Re-render Math', { delay: 15 });
  await page.waitForTimeout(700);
  const paletteEntries = await page.evaluate(() => {
    return [...document.querySelectorAll('.quick-input-list .monaco-list-row')]
      .map((r) => r.textContent.slice(0, 120))
      .slice(0, 5);
  });
  console.log('   palette matches:', JSON.stringify(paletteEntries));
  const hasCmd = paletteEntries.some((t) =>
    /Claude Code LaTeX: Re-render Math/.test(t)
  );
  console.log('   has rerender command:', hasCmd);
  await page.screenshot({ path: path.join(OUT, '02-palette.png') });
  // dismiss palette
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('5) opening Claude Code in new tab...');
  await openCommand(page, 'Claude Code: Open in New Tab');
  await page.waitForTimeout(14000);

  const cc = await getClaudeFrame(page);
  if (!cc) {
    console.log('FAIL: no claude code webview');
    await browser.close();
    process.exit(1);
  }
  console.log('   patch marker logs:', consoleLogs.slice(0, 3));

  console.log('6) verifying new observer code is what the webview loaded...');
  const bridgeStatus = await cc.evaluate(() => ({
    hasBridge: typeof window.__claudeCodeKatexRerender === 'function',
  }));
  console.log('   bridge present:', bridgeStatus.hasBridge);

  console.log('7) injecting raw $...$ assistant message...');
  const injectResult = await cc.evaluate(() => {
    // Empty new chats don't have a messagesContainer yet.  Create a fake
    // one so the observer + rerender shortcut have something to target.
    // The observer's SELECTOR is [class*="messagesContainer"] and its
    // rootObserver looks under #root for it.
    let container = document.querySelector('[class*="messagesContainer"]');
    if (!container) {
      container = document.createElement('div');
      container.className = 'messagesContainer_fakeForTest';
      const root = document.getElementById('root') || document.body;
      root.appendChild(container);
    }
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'assistant-message');
    wrap.style.padding = '8px';
    const p = document.createElement('p');
    p.textContent =
      'Synthetic test: inline $\\alpha + \\beta = \\gamma$ and display $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$';
    wrap.appendChild(p);
    container.appendChild(wrap);
    // Wait a beat then count katex BEFORE pressing the shortcut.
    return {
      ok: true,
      injectedRawDollars: (wrap.textContent.match(/\$/g) || []).length,
      katexBefore: wrap.querySelectorAll('.katex').length,
    };
  });
  console.log('   inject result:', injectResult);
  // give the observer's debounce a moment in case it auto-renders.
  await page.waitForTimeout(400);
  const stateAfterDebounce = await cc.evaluate(() => {
    const msgs = document.querySelectorAll('[data-testid="assistant-message"]');
    const last = msgs[msgs.length - 1];
    return {
      katex: last.querySelectorAll('.katex').length,
      rawDollars: (last.textContent.match(/\$/g) || []).length,
    };
  });
  console.log('   state after 400ms debounce:', stateAfterDebounce);

  if (stateAfterDebounce.katex > 0) {
    console.log(
      '   (observer auto-rendered — shortcut would be a no-op.  re-injecting fresh raw $.)'
    );
    // Inject a SECOND message that we'll explicitly NOT let the observer
    // touch (we'll press the shortcut immediately after).
    await cc.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      const wrap = document.createElement('div');
      wrap.setAttribute('data-testid', 'assistant-message');
      const p = document.createElement('p');
      p.textContent =
        'Shortcut-only test: $\\sin^2 \\theta + \\cos^2 \\theta = 1$';
      wrap.appendChild(p);
      container.appendChild(wrap);
    });
    // No wait — press shortcut immediately.
  }

  console.log('8) dispatching Ctrl+Alt+M keydown inside the iframe...');
  // Dispatch directly: more reliable across nested iframes than relying
  // on Playwright key forwarding to deliver focus + key to the right
  // frame.  Our handler reads e.code === 'KeyM' and the modifier flags.
  await cc.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await page.waitForTimeout(500);

  const finalState = await cc.evaluate(() => {
    const msgs = [...document.querySelectorAll('[data-testid="assistant-message"]')];
    return msgs.map((m, i) => ({
      idx: i,
      katex: m.querySelectorAll('.katex').length,
      display: m.querySelectorAll('.katex-display').length,
      rawDollars: (m.textContent.match(/\$/g) || []).length,
      sample: (m.textContent || '').slice(0, 80),
    }));
  });
  console.log('9) final state per assistant message:');
  for (const m of finalState) {
    console.log(`   msg#${m.idx} katex=${m.katex} display=${m.display} rawDollars=${m.rawDollars}  "${m.sample}"`);
  }
  await page.screenshot({ path: path.join(OUT, '03-after-shortcut.png') });

  const ok =
    hasLatexIndicator &&
    hasCmd &&
    bridgeStatus.hasBridge &&
    finalState.length > 0 &&
    finalState.every((m) => m.katex > 0 || m.rawDollars === 0);

  console.log('\n=== VERDICT ===');
  console.log(`  status bar indicator: ${hasLatexIndicator ? '✓' : '✗'}`);
  console.log(`  palette command:      ${hasCmd ? '✓' : '✗'}`);
  console.log(`  webview bridge:       ${bridgeStatus.hasBridge ? '✓' : '✗'}`);
  console.log(`  shortcut renders math: ${
    finalState.length > 0 && finalState.every((m) => m.katex > 0) ? '✓' : '?'
  }`);
  console.log(`  overall: ${ok ? 'OK' : 'CHECK SCREENSHOTS'}`);

  await browser.close();
  process.exit(ok ? 0 : 10);
})();
