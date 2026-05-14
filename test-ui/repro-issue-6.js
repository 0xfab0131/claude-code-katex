// Reproduction attempt for issue #6:
//   "Math expressions sometimes remain as raw $...$ during streaming
//    until window is reloaded"
// Reporter: ricitron, ext v1.7.6, VS Code 1.116.0, Claude Code 2.1.111.
//
// Strategy:
//   - Open Claude Code in a fresh Playwright context.
//   - Verify the patched JS is what's actually served (marker check).
//   - Send a math-heavy prompt N times in the same chat.
//   - After each turn, wait for streaming to fully settle, then snapshot
//     each assistant message: katex count, raw $ count, length.
//   - A "failure" = an assistant message with raw $ >= 2 and katex == 0
//     (or display $$ pair without .katex-display).
//   - Also instrument the MutationObserver so we can see if the observer
//     is even firing for the failing message.
//
// Cost: each iteration sends a real Claude Code prompt = real API tokens.
// Keep N modest.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:30110/?folder=/teamspace/studios/this_studio';

// Same-chat continuation x N.  No new-chat swap — keep state simple.
// Mix of long/structured prompts that exercise streaming under varied
// markdown structures (lists, code-block-then-math, tables).
const TURNS = [
  { kind: 'send', prompt: 'generate some latex equations' },
  {
    kind: 'send',
    prompt:
      'now show me 4 more equations as a numbered list, one display equation per item, with a brief one-line description',
  },
  {
    kind: 'send',
    prompt:
      'show a small python snippet computing the dot product, then below it write the formula in display math',
  },
  {
    kind: 'send',
    prompt:
      'in a single short paragraph, explain the chain rule and include both inline $...$ and display $$...$$ examples',
  },
  {
    kind: 'send',
    prompt:
      'list 3 quick differential equations as bullets, each with an inline LaTeX form',
  },
];

const OUT_DIR = path.join(__dirname, '..', 'test-results', 'issue-6');
fs.mkdirSync(OUT_DIR, { recursive: true });

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

// Run inside the iframe.  Returns whether the served webview script
// actually contains the v1.7.6 patch marker.
async function verifyPatchedScriptLoaded(cc) {
  return await cc.evaluate(async () => {
    const scripts = [...document.scripts].filter((s) => s.src);
    let report = [];
    for (const s of scripts) {
      try {
        const txt = await fetch(s.src).then((r) => r.text());
        report.push({
          src: s.src.slice(-120),
          hasPatchMarker: txt.includes('[KaTeX Patch] LaTeX rendering enabled'),
          hasKatexFn: txt.includes('renderMathInElement'),
          len: txt.length,
        });
      } catch (e) {
        report.push({ src: s.src.slice(-120), err: String(e) });
      }
    }
    return report;
  });
}

async function installInstrumentation(cc) {
  await cc.evaluate(() => {
    if (window.__kpInstrumented) return;
    window.__kpInstrumented = true;
    window.__kpLog = [];
    window.__renderLog = [];
    const t0 = performance.now();
    const Native = window.MutationObserver;
    window.__MOConstructions = 0;
    function Wrapped(cb) {
      window.__MOConstructions++;
      const id = window.__MOConstructions;
      return new Native((muts, obs) => {
        let kept = 0;
        const sample = [];
        for (const m of muts) {
          const tgt =
            m.target.nodeType === 1 ? m.target : m.target.parentElement;
          if (!tgt) continue;
          const inMsgs = !!(tgt.closest &&
            tgt.closest('[class*="messagesContainer"]'));
          if (!inMsgs) continue;
          kept++;
          if (sample.length < 3) {
            sample.push({
              type: m.type,
              tag: tgt.tagName,
              addedEl: [...m.addedNodes].filter((n) => n.nodeType === 1)
                .length,
              addedText: [...m.addedNodes].filter((n) => n.nodeType === 3)
                .length,
              chr:
                m.type === 'characterData'
                  ? String(m.target.nodeValue || '').slice(0, 40)
                  : '',
            });
          }
        }
        if (kept > 0) {
          window.__kpLog.push({
            t: Math.round(performance.now() - t0),
            obs: id,
            kept,
            total: muts.length,
            sample,
          });
        }
        cb(muts, obs);
      });
    }
    Object.setPrototypeOf(Wrapped, Native);
    Wrapped.prototype = Native.prototype;
    window.MutationObserver = Wrapped;

    // also hook console so we capture the extension's log lines into __kpLog
    const origLog = console.log;
    console.log = function (...args) {
      try {
        const s = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
        if (s.includes('KaTeX')) {
          window.__renderLog.push({
            t: Math.round(performance.now() - t0),
            msg: s.slice(0, 200),
          });
        }
      } catch (_) {}
      return origLog.apply(this, args);
    };
  });
}

async function snapshotMessages(cc) {
  return await cc.evaluate(() => {
    const msgs = [
      ...document.querySelectorAll('[data-testid="assistant-message"]'),
    ];
    return msgs.map((m, i) => {
      const text = m.textContent || '';
      const html = m.innerHTML || '';
      const rawDollars = (text.match(/\$/g) || []).length;
      const dollarDollarPairs = (html.match(/\$\$/g) || []).length;
      const katexInline = m.querySelectorAll('.katex').length;
      const katexDisplay = m.querySelectorAll('.katex-display').length;
      // crude "looks broken" check: pairs of $ in text and 0 katex
      return {
        idx: i,
        len: text.length,
        rawDollars,
        dollarDollarPairs,
        katex: katexInline,
        display: katexDisplay,
        broken: rawDollars >= 2 && katexInline === 0,
      };
    });
  });
}

async function waitForStreamingDone(cc, page, label) {
  // Streaming considered done when assistant message text length is stable
  // for STABLE_MS milliseconds AND length is non-trivial.
  const STABLE_MS = 6000;
  const TIMEOUT_MS = 120000;
  const startedAt = Date.now();
  let lastLen = 0;
  let lastChangeAt = Date.now();
  let lastSnap = null;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await page.waitForTimeout(500);
    const msgs = await snapshotMessages(cc);
    if (msgs.length === 0) continue;
    const last = msgs[msgs.length - 1];
    if (!lastSnap || last.len !== lastLen) {
      lastLen = last.len;
      lastChangeAt = Date.now();
    }
    lastSnap = last;
    const stableFor = Date.now() - lastChangeAt;
    if (last.len > 80 && stableFor >= STABLE_MS) break;
  }
  console.log(
    `[${label}] streaming done after ${Math.round(
      (Date.now() - startedAt) / 100
    ) / 10}s, last={len:${lastSnap?.len}, katex:${lastSnap?.katex}, rawDollars:${lastSnap?.rawDollars}}`
  );
  return lastSnap;
}

async function dismissAnyModal(page, label) {
  // First: click Cancel on any VS Code-level modal (e.g. GitHub Copilot
  // Chat sign-in dialog) since Escape can have side effects on Claude Code.
  try {
    const cancel = page.locator('.monaco-dialog-modal-block button:has-text("Cancel")').first();
    if ((await cancel.count()) > 0) {
      await cancel.click({ timeout: 1500 });
      console.log(`[${label}] dismissed a modal via Cancel`);
      await page.waitForTimeout(300);
    }
  } catch (_) {}
}

async function describeOverlays(cc, label) {
  try {
    const info = await cc.evaluate(() => {
      const overlays = [
        ...document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="dialog"]'),
      ]
        .filter((el) => el.offsetParent !== null) // visible
        .slice(0, 5)
        .map((el) => ({
          tag: el.tagName,
          cls: (el.className || '').slice(0, 80),
          text: (el.textContent || '').slice(0, 120).replace(/\s+/g, ' ').trim(),
        }));
      return overlays;
    });
    if (info.length) {
      console.log(`[${label}] visible overlays:`, JSON.stringify(info));
    }
    return info;
  } catch (e) {
    return [];
  }
}

async function dismissWebviewOverlay(cc, page, label) {
  // Close any visible Claude Code in-webview dialog (e.g. "Rewind to..."
  // which has an X-close in the top-right).  Look for buttons with X icon
  // OR matching dismiss-text.
  try {
    const handled = await cc.evaluate(() => {
      const dialogs = [
        ...document.querySelectorAll('[class*="dialog"], [class*="overlay"]'),
      ].filter((el) => el.offsetParent !== null);
      let clicked = null;
      for (const d of dialogs) {
        const btns = [...d.querySelectorAll('button')];
        for (const b of btns) {
          const t = (b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const hasCloseIcon = !!b.querySelector(
            '[class*="close"], [aria-label*="close" i]'
          );
          if (
            /^(continue|got it|close|dismiss|ok|skip|maybe later|not now|x|×)$/.test(
              t
            ) ||
            /close|dismiss/i.test(aria) ||
            hasCloseIcon
          ) {
            b.click();
            clicked = t || aria || 'close-icon';
            break;
          }
        }
        if (clicked) break;
      }
      return clicked;
    });
    if (handled) console.log(`[${label}] clicked overlay button: "${handled}"`);
  } catch (_) {}
}

async function sendPrompt(cc, page, prompt, label) {
  await dismissAnyModal(page, label);
  await dismissWebviewOverlay(cc, page, label);
  // Debug snapshot if input is blocked by overlay.
  const inputLoc = cc.locator('[aria-label="Message input"]').first();
  try {
    await inputLoc.click({ timeout: 8000 });
  } catch (err) {
    await describeOverlays(cc, label);
    await page.screenshot({
      path: path.join(OUT_DIR, `blocked-${label.replace(/[^\w]/g, '_')}.png`),
    });
    // Try Escape + retry once
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await dismissWebviewOverlay(cc, page, label);
    await inputLoc.click({ timeout: 8000 });
  }
  await page.waitForTimeout(200);
  await page.keyboard.type(prompt, { delay: 10 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  console.log(`[${label}] sent: ${prompt}`);
}

async function startNewChat(cc, page, label) {
  await dismissAnyModal(page, label);
  // Try the Claude Code "Open in New Tab" command — gives us a fresh chat
  // session in a new editor tab, exercising the container-swap code path.
  await openCommand(page, 'Claude Code: Open in New Tab');
  await page.waitForTimeout(8000);
  // Re-find the frame in case the new tab gave us a fresh webview iframe.
  const fresh = await getClaudeFrame(page);
  console.log(`[${label}] new chat opened; fresh frame: ${!!fresh}`);
  return fresh || cc;
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

  const consoleHits = [];
  page.on('console', (m) => {
    const t = m.text();
    if (
      t.includes('KaTeX') ||
      t.includes('katex') ||
      t.includes('renderMath')
    ) {
      consoleHits.push(t);
    }
  });

  console.log('navigating to code-server...');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  console.log('opening Claude Code in new tab...');
  await openCommand(page, 'Claude Code: Open in New Tab');
  await page.waitForTimeout(14000);

  const cc = await getClaudeFrame(page);
  if (!cc) {
    console.log('FAIL: no claude code webview');
    await browser.close();
    process.exit(1);
  }

  console.log('console hits so far:', consoleHits.slice(0, 5));

  // Primary verification: did we capture the patch's console marker?
  // The fetch-from-iframe check is unreliable for webview-served files.
  const patchLoaded = consoleHits.some((t) =>
    t.includes('[KaTeX Patch] LaTeX rendering enabled')
  );
  if (!patchLoaded) {
    console.log(
      'FAIL: no KaTeX patch marker seen in console — extension did not patch the webview'
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'no-patch.png') });
    await browser.close();
    process.exit(2);
  }
  console.log('  patch marker present in console → patched 1.7.6 is loaded');

  await installInstrumentation(cc);

  // Clear any startup modals (GitHub Copilot Chat sign-in, etc.) before
  // we start sending prompts.  Repeat a few times — modals may appear with
  // a delay after the workbench loads.
  for (let i = 0; i < 3; i++) {
    await dismissAnyModal(page, 'startup');
    await dismissWebviewOverlay(cc, page, 'startup');
    await page.waitForTimeout(1500);
  }

  // Walk through the configured TURNS.  Some are prompts, some are
  // "new-chat" steps that swap the assistant-message container.
  let curFrame = cc;
  const results = [];
  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const label = `step ${i + 1}/${TURNS.length}`;
    if (turn.kind === 'new-chat') {
      curFrame = await startNewChat(curFrame, page, label);
      await installInstrumentation(curFrame);
      continue;
    }
    await sendPrompt(curFrame, page, turn.prompt, label);
    await waitForStreamingDone(curFrame, page, label);
    // Extra settle delay after stable, to be sure nothing is in flight.
    await page.waitForTimeout(2500);
    const msgs = await snapshotMessages(curFrame);
    const screenshot = path.join(OUT_DIR, `after-step-${i + 1}.png`);
    await page.screenshot({ path: screenshot });
    results.push({ step: i + 1, prompt: turn.prompt, msgs });
    console.log(`[${label}] snapshot:`);
    for (const m of msgs) {
      const flag = m.broken ? ' BROKEN' : '';
      console.log(
        `    msg#${m.idx} len=${m.len} katex=${m.katex} display=${m.display} rawDollars=${m.rawDollars}${flag}`
      );
    }
  }

  // Pull the observer log from the most recent frame
  const obsLog = await curFrame.evaluate(() => ({
    log: window.__kpLog || [],
    renderLog: window.__renderLog || [],
    moConstructions: window.__MOConstructions || 0,
  }));
  fs.writeFileSync(
    path.join(OUT_DIR, 'observer-log.json'),
    JSON.stringify(obsLog, null, 2)
  );

  // Compute summary
  const allMsgs = results.flatMap((r) => r.msgs);
  const broken = allMsgs.filter((m) => m.broken);
  const summary = {
    totalAssistantMessages: allMsgs.length,
    brokenMessages: broken.length,
    moConstructions: obsLog.moConstructions,
    observerCallbacksLogged: obsLog.log.length,
    results,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log('\n=== SUMMARY ===');
  console.log(
    `assistant messages: ${allMsgs.length}, broken: ${broken.length}`
  );
  console.log(
    `MutationObservers constructed: ${obsLog.moConstructions}, callback log entries: ${obsLog.log.length}`
  );
  console.log(`outputs in: ${OUT_DIR}`);

  await browser.close();
  process.exit(broken.length > 0 ? 10 : 0);
})();
