// Clean verification: fresh Playwright browser, new chat, same prompt.
// If PR #3's setInterval fix is working, math renders within ~1s of stream end.
const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';
const PROMPT = 'generate some latex equations';

async function openCommand(page, cmd) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type(cmd, { delay: 15 });
  await page.waitForTimeout(500);
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  // Capture KaTeX marker logs to confirm which version is loaded
  const markerLogs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('KaTeX') || t.includes('vFAILSAFE')) markerLogs.push(t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  await openCommand(page, 'Claude Code: Open in New Tab');
  await page.waitForTimeout(12000);

  console.log('KaTeX logs captured:', markerLogs);

  const cc = await getClaudeFrame(page);
  if (!cc) { console.log('no webview'); await browser.close(); process.exit(1); }

  const input = cc.locator('[aria-label="Message input"]').first();
  await input.click();
  await page.waitForTimeout(400);
  await page.keyboard.type(PROMPT, { delay: 15 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  console.log('prompt sent, watching...');

  let stableSince = null;
  let lastLen = 0;
  let consecutiveStable = 0;
  for (let i = 1; i <= 60; i++) {
    await page.waitForTimeout(500);
    const snap = await cc.evaluate(() => {
      const msgs = document.querySelectorAll('[data-testid="assistant-message"]');
      if (msgs.length === 0) return null;
      const last = msgs[msgs.length - 1];
      const text = last.textContent || '';
      return {
        katex: last.querySelectorAll('.katex').length,
        display: last.querySelectorAll('.katex-display').length,
        len: text.length,
        rawDollars: (text.match(/\$/g) || []).length,
      };
    });
    if (snap && snap.len > 100 && snap.len === lastLen) {
      consecutiveStable++;
      if (consecutiveStable >= 6) break;  // stable at >100 chars for 3s = done
    } else if (snap) {
      if (snap.len !== lastLen) { lastLen = snap.len; consecutiveStable = 0; }
    }
    if (i % 4 === 0) console.log(`[${i*500}ms]`, JSON.stringify(snap));
  }

  await page.screenshot({ path: 'test-results/verify-final.png' });

  const final = await cc.locator('[data-testid="assistant-message"]').evaluateAll((els) =>
    els.map((el) => ({
      katex: el.querySelectorAll('.katex').length,
      display: el.querySelectorAll('.katex-display').length,
      len: (el.textContent || '').length,
      rawDollars: ((el.textContent || '').match(/\$/g) || []).length,
    }))
  );
  console.log('\n=== FINAL ===');
  console.log(JSON.stringify(final, null, 2));
  console.log('\nverdict:', final.some((f) => f.katex > 0) ? '✅ MATH RENDERED' : '❌ STILL BROKEN');

  await browser.close();
})();
