// Fetch the webview index.js from within the webview itself to see what VS Code
// is actually serving. Compare with disk content.
const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await (await browser.newContext()).newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type('Claude Code: Open in New Tab', { delay: 15 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(12000);

  for (const f of page.frames()) {
    try {
      const r = await f.locator('#root').count();
      const inp = await f.locator('[aria-label="Message input"]').count();
      if (r > 0 && inp > 0) {
        // Look at script tags and their sources
        const info = await f.evaluate(async () => {
          const out = { scripts: [], fetched: null };
          for (const s of document.scripts) {
            out.scripts.push({
              src: s.src,
              inline: s.textContent ? s.textContent.slice(0, 80) : '',
              length: s.textContent ? s.textContent.length : 0,
            });
          }
          // Try to fetch the index.js directly to see what's served
          const indexScript = [...document.scripts].find((s) => s.src && s.src.includes('index.js') && !s.src.includes('vendor'));
          if (indexScript) {
            try {
              const resp = await fetch(indexScript.src);
              const text = await resp.text();
              out.fetched = {
                url: indexScript.src,
                status: resp.status,
                length: text.length,
                hasVROOTFIX: text.includes('vROOTFIX'),
                hasRenderDirtyMessages: text.includes('renderDirtyMessages'),
                hasRenderNewNodes: text.includes('renderNewNodes'),
                last100: text.slice(-200),
              };
            } catch (e) {
              out.fetched = { error: e.message };
            }
          }
          return out;
        });
        console.log('frame info:', JSON.stringify(info, null, 2));
      }
    } catch (_) {}
  }

  await browser.close();

  // Compare with disk
  const onDisk = fs.readFileSync('/teamspace/studios/this_studio/.vscode-server/extensions/anthropic.claude-code-2.1.116-linux-x64/webview/index.js', 'utf8');
  console.log('\nOn disk:');
  console.log('  length:', onDisk.length);
  console.log('  hasVROOTFIX:', onDisk.includes('vROOTFIX'));
  console.log('  hasRenderDirtyMessages:', onDisk.includes('renderDirtyMessages'));
  console.log('  hasRenderNewNodes:', onDisk.includes('renderNewNodes'));
})();
