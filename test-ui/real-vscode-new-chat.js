// Reproduce the user's exact scenario:
// 1. Open Claude Code in primary editor (new chat)
// 2. Prompt: "generate some latex equations"
// 3. Observe whether math renders during streaming or stays as raw LaTeX
const { chromium } = require('playwright');
const fs = require('fs');

const CODE_SERVER_URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';
const PROMPT = 'generate some latex equations';

async function openCommand(page, cmdText) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(500);
  await page.keyboard.type(cmdText, { delay: 20 });
  await page.waitForTimeout(700);
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

  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[kp]')) console.log(t);
    else if (m.type() === 'error' && !t.includes('lai-bridge') && !t.includes('CSP') && !t.includes('404')) {
      console.log('[err]', t.slice(0, 200));
    }
  });

  await page.goto(CODE_SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000);

  // Open Claude in a NEW TAB so we get a fresh session (not resume prior).
  console.log('opening Claude Code in new tab...');
  await openCommand(page, 'Claude Code: Open in New Tab');
  await page.waitForTimeout(12000);

  const ccFrame = await getClaudeFrame(page);
  if (!ccFrame) { console.log('no webview'); await browser.close(); process.exit(1); }
  console.log('webview frame found');

  // Install pre-KaTeX MutationObserver instrumentation if possible. The KaTeX
  // observer has already been created by this point (extension loads at
  // startup), so we wrap new MOs only — that's fine for tracking secondary
  // observers, but the KaTeX one itself we can't re-wrap. Instead we add an
  // independent observer to log ALL mutations in messagesContainer regardless.
  await ccFrame.evaluate(() => {
    if (window.__logged) return;
    window.__logged = true;
    window.__kpLog = [];
    const t0 = performance.now();
    const attach = () => {
      const container = document.querySelector('[class*="messagesContainer"]');
      if (!container) {
        setTimeout(attach, 200);
        return;
      }
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          const tgt = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          if (!tgt) continue;
          const added = [];
          for (let j = 0; j < m.addedNodes.length; j++) {
            const n = m.addedNodes[j];
            added.push(n.nodeType === 1 ? 'EL:' + n.tagName : 'TEXT:' + JSON.stringify(String(n.nodeValue || '').slice(0, 30)));
          }
          const removed = [];
          for (let j = 0; j < m.removedNodes.length; j++) {
            const n = m.removedNodes[j];
            removed.push(n.nodeType === 1 ? 'EL:' + n.tagName : 'TEXT:' + JSON.stringify(String(n.nodeValue || '').slice(0, 30)));
          }
          window.__kpLog.push({
            t: Math.round(performance.now() - t0),
            type: m.type,
            tgt: tgt.tagName,
            tgtClass: (tgt.className || '').toString().slice(0, 80),
            added: added.join(','),
            removed: removed.join(','),
            chr: m.type === 'characterData' ? String(m.target.nodeValue || '').slice(0, 30) : '',
          });
        }
      });
      obs.observe(container, { childList: true, subtree: true, characterData: true });
      console.log('[kp] observer attached to', container.className);
    };
    attach();
  });

  const input = ccFrame.locator('[aria-label="Message input"]').first();
  await input.click();
  await page.waitForTimeout(500);
  console.log('typing prompt:', PROMPT);
  await page.keyboard.type(PROMPT, { delay: 15 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  console.log('sent, monitoring state...');

  const samples = [];
  for (let i = 1; i <= 40; i++) {
    await page.waitForTimeout(500);
    const snap = await ccFrame.evaluate(() => {
      const msgs = document.querySelectorAll('[data-testid="assistant-message"]');
      if (msgs.length === 0) return null;
      const last = msgs[msgs.length - 1];
      const text = last.textContent || '';
      return {
        n: msgs.length,
        katex: last.querySelectorAll('.katex').length,
        display: last.querySelectorAll('.katex-display').length,
        textLen: text.length,
        rawDollars: (text.match(/\$/g) || []).length,
        rawLatexCmds: (text.match(/\\[a-zA-Z]+/g) || []).length,
        snippet: text.slice(0, 200),
      };
    });
    samples.push({ ms: i * 500, ...(snap || {}) });
    if (i % 4 === 0) {
      await page.screenshot({ path: `test-results/newchat-${String(i).padStart(2, '0')}.png` });
    }
  }

  console.log('\n=== sample trace ===');
  for (const s of samples) {
    if (s.n) console.log(`[${s.ms}ms] msgs=${s.n} katex=${s.katex} display=${s.display} len=${s.textLen} rawDollars=${s.rawDollars} rawCmds=${s.rawLatexCmds}`);
  }

  // Dump mutation log (within messagesContainer only)
  const log = await ccFrame.evaluate(() => window.__kpLog || []);
  fs.writeFileSync('test-results/newchat-mutations.json', JSON.stringify(log, null, 2));
  console.log('\nmutation log entries:', log.length);
  const byType = {};
  for (const m of log) {
    const key = m.type + (m.added.startsWith('EL:') ? ':+' + m.added.split(',')[0] : (m.added.startsWith('TEXT:') ? ':+TEXT' : ''));
    byType[key] = (byType[key] || 0) + 1;
  }
  console.log('mutation types:', JSON.stringify(byType, null, 2));

  // Final: reload and check if math now renders (matches user's behavior).
  console.log('\n--- taking final screenshot BEFORE reload ---');
  await page.screenshot({ path: 'test-results/newchat-BEFORE-reload.png' });
  const preFinal = await ccFrame.locator('[data-testid="assistant-message"]').evaluateAll((els) =>
    els.map((el) => ({ katex: el.querySelectorAll('.katex').length, display: el.querySelectorAll('.katex-display').length, textLen: (el.textContent || '').length, rawDollars: ((el.textContent || '').match(/\$/g) || []).length }))
  );
  console.log('BEFORE reload:', JSON.stringify(preFinal));

  // Reload and re-find
  console.log('--- reloading window ---');
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('Developer: Reload Window', { delay: 20 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(15000);

  const cc2 = await getClaudeFrame(page);
  if (cc2) {
    const postFinal = await cc2.locator('[data-testid="assistant-message"]').evaluateAll((els) =>
      els.map((el) => ({ katex: el.querySelectorAll('.katex').length, display: el.querySelectorAll('.katex-display').length, textLen: (el.textContent || '').length, rawDollars: ((el.textContent || '').match(/\$/g) || []).length }))
    );
    console.log('AFTER reload:', JSON.stringify(postFinal));
    await page.screenshot({ path: 'test-results/newchat-AFTER-reload.png' });
  } else {
    console.log('could not reacquire webview after reload');
  }

  await browser.close();
})();
