// Check what version of the KaTeX patch is actually loaded in the webview.
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.text().includes('KaTeX')) console.log('[console]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type('Claude Code: Open in New Tab', { delay: 15 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(12000);

  // Find Claude Code frame
  for (const f of page.frames()) {
    try {
      const r = await f.locator('#root').count();
      const inp = await f.locator('[aria-label="Message input"]').count();
      if (r > 0 && inp > 0) {
        const v = await f.evaluate(() => window.__KATEX_VERSION || null);
        console.log('frame', f.url().slice(-50), 'katex_version:', v);
        // Also check hasFailsafe by looking for renderDirtyMessages (can't easily)
        // but let's check if renderMath exists and what other symbols are there
        const debug = await f.evaluate(() => {
          try {
            return {
              hasRenderMath: typeof window.renderMath,
              katexGlobal: typeof window.katex,
              renderMathInElement: typeof window.renderMathInElement,
              version: window.__KATEX_VERSION,
            };
          } catch (e) { return { err: e.message }; }
        });
        console.log('debug:', JSON.stringify(debug));
      }
    } catch (_) {}
  }
  await browser.close();
})();
