// Probe: what frames show up after opening Claude Code, and what's inside them?
const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000);
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Claude Code: Open in Primary Editor', { delay: 15 });
  await page.waitForTimeout(700);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(15000);

  const frames = page.frames();
  console.log('frame count:', frames.length);
  for (const f of frames) {
    const url = f.url();
    console.log('\n=== FRAME:', url.slice(0, 200));
    try {
      const html = await f.evaluate(() => document.documentElement.outerHTML.slice(0, 500)).catch(() => 'eval failed');
      console.log('  head:', html.replace(/\n/g, ' ').slice(0, 300));
    } catch (e) {
      console.log('  eval failed:', e.message);
    }
    try {
      const rootCount = await f.locator('#root').count();
      const inputCount = await f.locator('[aria-label="Message input"]').count();
      const msgContCount = await f.locator('[class*="messagesContainer"]').count();
      console.log('  #root:', rootCount, 'Message input:', inputCount, 'messagesContainer:', msgContCount);
    } catch (e) {
      console.log('  locator failed:', e.message);
    }
  }

  // Try finding the Claude Code webview via its parent outer iframe.
  const ccOuter = frames.find((f) => f.url().includes('Anthropic.claude-code'));
  if (ccOuter) {
    console.log('\n=== nested inspection of Claude Code outer frame ===');
    // list child frames
    const children = ccOuter.childFrames();
    console.log('child frames:', children.length);
    for (const c of children) {
      console.log('  child url:', c.url().slice(0, 200));
      try {
        const rootCount = await c.locator('#root').count();
        const inputCount = await c.locator('[aria-label="Message input"]').count();
        console.log('    #root:', rootCount, 'input:', inputCount);
      } catch (e) {}
    }
  }

  await browser.close();
})();
