const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';

// This extension's own version. It is stamped into the patch (right after
// PATCH_MARKER) so a newer build can recognize "patched, but by an older
// build" and refresh the injected code instead of leaving it stale.
const EXTENSION_VERSION = require('./package.json').version;
// Version-agnostic prefix of the stamp line: `/* katex-ext-version: X.Y.Z */`.
// Patches from builds <= 1.9.0 have no stamp at all (getPatchedVersion -> null).
const PATCH_VERSION_PREFIX = '/* katex-ext-version: ';
// Stamp recording which rendering path the patch installed: `v2` (the
// remark-math pipeline injected into react-markdown) or `v1-fallback` (the
// DOM post-processor, used when the injection point is not found).
const PATCH_MODE_PREFIX = '/* katex-ext-mode: ';

// The react-markdown call site in Claude Code's webview bundle:
//   createElement(<Markdown>, {remarkPlugins:[<plugins>], components:{...}}, <text>)
// v2 injects the math plugins here. $1 = the Markdown component identifier,
// $2 = the existing remark plugin list. Verified to match exactly once on
// Claude Code 2.1.144; if a future build changes shape, applyPatch falls back
// to the v1 DOM post-processor.
const V2_INJECT_RE = /createElement\(([A-Za-z_$][\w$]*),\{remarkPlugins:\[([A-Za-z_$][\w$,]*)\]/;

function findClaudeCodeExtDir() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    return ext.extensionPath;
  }
  return null;
}

function isPatched(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    return js.includes(PATCH_MARKER);
  } catch {
    return false;
  }
}

// Reads the extension version stamped into the patch. Returns the version
// string, or null when the webview is unpatched or carries a patch from a
// pre-versioning build (<= 1.9.0, which wrote no stamp).
function getPatchedVersion(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const start = js.indexOf(PATCH_VERSION_PREFIX);
    if (start === -1) return null;
    const rest = js.slice(start + PATCH_VERSION_PREFIX.length);
    const end = rest.indexOf(' */');
    if (end === -1) return null;
    return rest.slice(0, end).trim();
  } catch {
    return null;
  }
}

// Reads the rendering-path stamp from the patched webview. Returns 'v2',
// 'v1-fallback', or null (unpatched, or a pre-2.0.0 patch with no mode stamp).
function getPatchedMode(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const start = js.indexOf(PATCH_MODE_PREFIX);
    if (start === -1) return null;
    const rest = js.slice(start + PATCH_MODE_PREFIX.length);
    const end = rest.indexOf(' */');
    if (end === -1) return null;
    return rest.slice(0, end).trim();
  } catch {
    return null;
  }
}

function applyPatch(extDir, vendorDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsPath = path.join(webviewDir, 'index.js');
  const cssPath = path.join(webviewDir, 'index.css');

  // Back up originals if not already backed up
  for (const f of [jsPath, cssPath]) {
    if (!fs.existsSync(f + '.katex-bak')) {
      fs.copyFileSync(f, f + '.katex-bak');
    }
  }

  // Copy KaTeX fonts (both rendering paths need them)
  const fontsTarget = path.join(webviewDir, 'fonts');
  const fontsSrc = path.join(vendorDir, 'fonts');
  if (!fs.existsSync(fontsTarget)) {
    fs.mkdirSync(fontsTarget, { recursive: true });
  }
  for (const font of fs.readdirSync(fontsSrc)) {
    fs.copyFileSync(path.join(fontsSrc, font), path.join(fontsTarget, font));
  }

  // Patch index.js. The webview bundle always loads before this extension
  // activates, so the patch lives on disk and a webview reload picks it up.
  const katexCore = fs.readFileSync(path.join(vendorDir, 'katex.min.js'), 'utf8');
  const body = fs.readFileSync(jsPath, 'utf8');
  const stamp = `${PATCH_MARKER}\n${PATCH_VERSION_PREFIX}${EXTENSION_VERSION} */\n`;
  let patchedJs;
  let mode;

  if (V2_INJECT_RE.test(body)) {
    // v2 — inject the remark-math + rehype-katex pipeline into Claude Code's
    // react-markdown call. remark-math tokenizes $...$ / $$...$$ during
    // micromark tokenization, capturing the LaTeX verbatim BEFORE CommonMark's
    // characterEscape collapses `\\` (matrix row separators) and before block
    // parsing can mis-read a lone `=` line as a setext heading. The injected
    // plugin references are guarded on window.__KATEX_V2_LOADED so that if the
    // bundle ever fails to load, Claude Code's markdown still renders normally.
    const v2Bundle = fs.readFileSync(path.join(vendorDir, 'remark-math-bundle.js'), 'utf8');
    const injectedBody = body.replace(
      V2_INJECT_RE,
      'createElement($1,{rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[],' +
      'remarkPlugins:[$2].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])'
    );
    // Prepended, not appended: Claude Code mounts its React app at the end of
    // the bundle, so window.__remarkMath etc. must be defined before that runs.
    patchedJs =
      `${stamp}${PATCH_MODE_PREFIX}v2 */\n` +
      `/* KaTeX Core - MIT License - https://katex.org */\n${katexCore}\n` +
      `/* remark-math + rehype-katex pipeline */\n${v2Bundle}\n` +
      `/* === End KaTeX Patch — Claude Code bundle (math plugins injected) follows === */\n` +
      injectedBody;
    mode = 'v2';
  } else {
    // Fallback — the injection point was not found (Claude Code changed its
    // bundle shape). Install v1's DOM post-processor so rendering still works.
    const autoRender = fs.readFileSync(path.join(vendorDir, 'auto-render.min.js'), 'utf8');
    patchedJs = body +
      `\n${stamp}${PATCH_MODE_PREFIX}v1-fallback */\n` +
      `/* KaTeX Core - MIT License - https://katex.org */\n${katexCore}\n` +
      `/* KaTeX Auto-Render Extension */\n${autoRender}\n` +
      `${getMutationObserverScript()}\n` +
      `/* === End KaTeX Patch === */`;
    mode = 'v1-fallback';
  }

  fs.writeFileSync(jsPath, patchedJs);

  // Patch index.css — KaTeX styles (both rendering paths produce .katex /
  // .katex-display elements)
  const katexCss = fs.readFileSync(path.join(vendorDir, 'katex.min.css'), 'utf8');
  const cssPatch = `
${PATCH_CSS_MARKER}
${katexCss}
.katex-display {
  margin: 0.5em 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.25em 0;
}
.katex-display > .katex {
  white-space: normal;
}
.katex {
  font-size: 1.1em;
}
/* === End KaTeX CSS Patch === */`;

  fs.appendFileSync(cssPath, cssPatch);

  return mode;
}

function removePatch(extDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsPath = path.join(webviewDir, 'index.js');
  const cssPath = path.join(webviewDir, 'index.css');

  let restored = false;
  for (const f of [jsPath, cssPath]) {
    const bak = f + '.katex-bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      restored = true;
    }
  }

  const fontsDir = path.join(webviewDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true });
  }

  return restored;
}

// True only when the `.katex-bak` originals exist AND are themselves unpatched,
// so removePatch() would restore genuine pristine files. This guards the
// refresh path in ensurePatched(): we never append a second patch, and never
// treat an already-patched file as if it were the backup-able original.
function canRestoreOriginals(extDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsBak = path.join(webviewDir, 'index.js.katex-bak');
  const cssBak = path.join(webviewDir, 'index.css.katex-bak');
  try {
    if (!fs.existsSync(jsBak) || !fs.existsSync(cssBak)) return false;
    if (fs.readFileSync(jsBak, 'utf8').includes(PATCH_MARKER)) return false;
    if (fs.readFileSync(cssBak, 'utf8').includes(PATCH_CSS_MARKER)) return false;
    return true;
  } catch {
    return false;
  }
}

// Ensures Claude Code's webview carries THIS build's patch. Returns:
//   'fresh'     - was unpatched; patch applied
//   'refreshed' - carried an older/unstamped patch; originals restored, re-patched
//   'current'   - already patched with this exact version; nothing done
//   'skipped'   - patch is stale but cannot be refreshed safely; left untouched
// May throw on filesystem errors from applyPatch/removePatch; callers handle.
function ensurePatched(extDir, vendorDir) {
  if (!isPatched(extDir)) {
    applyPatch(extDir, vendorDir);
    return 'fresh';
  }
  if (getPatchedVersion(extDir) === EXTENSION_VERSION) {
    return 'current';
  }
  // A patch from an older (or pre-versioning) build is present. Refresh it so
  // the injected code matches this build. applyPatch only ever APPENDS, so we
  // must restore the pristine originals first — and only if that is safe.
  if (!canRestoreOriginals(extDir)) {
    console.warn('[Claude Code LaTeX] Webview carries a stale patch but the original backup is missing or invalid; leaving the existing patch in place.');
    return 'skipped';
  }
  removePatch(extDir);
  if (isPatched(extDir)) {
    // Restore did not produce a clean file — refuse to append a second patch.
    console.error('[Claude Code LaTeX] Restore did not clear the old patch; not re-applying, to avoid a double patch.');
    return 'skipped';
  }
  applyPatch(extDir, vendorDir);
  return 'refreshed';
}

function getMutationObserverScript() {
  return `
/* KaTeX MutationObserver - post-processes rendered markdown */
(function() {
  var renderTimeout = null;
  var isRendering = false;
  var activeContainer = null;
  var SELECTOR = '[class*="messagesContainer"]';
  var KATEX_PROCESSED = 'data-katex-processed';

  // preprocessMath uses a DOM-range approach because react-markdown (remark)
  // splits $...$ across multiple DOM nodes when underscores in LaTeX trigger
  // emphasis. For example, $\\tilde{T}_{\\text{travel}}^{(k)}$ becomes:
  //   TextNode("$\\tilde{T}") <em> TextNode("{\\text{travel}}") </em> TextNode("^{(k)}$")
  //
  // We cannot use innerHTML replacement because react-markdown renders <a> tags
  // with React event handlers (onClick for file links, onContextMenu). Setting
  // innerHTML would destroy those handlers.
  //
  // Instead, we walk the DOM collecting text content across nodes, find $...$
  // patterns in the concatenated text, then replace just the matched ranges
  // with \\(...\\) text nodes, preserving all other DOM nodes untouched.

  var IGNORED_TAGS = {SCRIPT:1,NOSCRIPT:1,STYLE:1,TEXTAREA:1,PRE:1,CODE:1,OPTION:1};

  // Collect text nodes under an element, building a map from character offsets
  // in the concatenated string back to the individual DOM text nodes.
  function collectTextMap(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var entries = []; // {node, start, end}
    var offset = 0;
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var parent = node.parentElement;
      if (parent && parent.closest && parent.closest('.katex,.katex-display')) continue;
      if (parent && IGNORED_TAGS[parent.tagName]) continue;
      var len = node.textContent.length;
      entries.push({node: node, start: offset, end: offset + len});
      offset += len;
    }
    return {entries: entries, text: entries.map(function(e){return e.node.textContent}).join('')};
  }

  // Find $...$ and $$...$$ in concatenated text. Returns array of {start, end, latex, display}.
  function findMathRanges(text) {
    var ranges = [];
    var i = 0;
    while (i < text.length) {
      if (text[i] === '$') {
        // Check for display math $$
        if (text[i+1] === '$') {
          var close = text.indexOf('$$', i + 2);
          if (close !== -1) {
            ranges.push({start: i, end: close + 2, latex: text.slice(i + 2, close), display: true});
            i = close + 2;
            continue;
          }
        }
        // Check for inline math $
        // Pandoc rules: after $ must be non-space, before closing $ must be non-space,
        // closing $ must not be followed by digit
        if (i > 0 && text[i-1] === '\\\\') { i++; continue; } // escaped
        if (i > 0 && text[i-1] === '$') { i++; continue; } // part of $$
        var j = i + 1;
        if (j >= text.length || text[j] === ' ' || text[j] === '\\t' || text[j] === '\\n') { i++; continue; }
        // Find closing $
        while (j < text.length) {
          if (text[j] === '$' && text[j-1] !== ' ' && text[j-1] !== '\\t' && text[j-1] !== '\\n') {
            // Check not followed by digit and not part of $$
            if (j + 1 < text.length && text[j+1] >= '0' && text[j+1] <= '9') { j++; continue; }
            if (j + 1 < text.length && text[j+1] === '$') { j++; continue; }
            // Found valid closing $
            ranges.push({start: i, end: j + 1, latex: text.slice(i + 1, j), display: false});
            i = j + 1;
            break;
          }
          if (text[j] === '\\n') break; // inline math cannot span lines
          j++;
        }
        if (j >= text.length || text[j] === '\\n') i++;
      } else {
        i++;
      }
    }
    return ranges;
  }

  // Replace matched math ranges in the DOM with \\(...\\) or \\[...\\] text nodes.
  // Works backwards to preserve offsets. Only modifies text nodes in the match range;
  // element nodes (like <a> with React handlers) between text nodes are removed only
  // if they fall entirely within the math expression (e.g. <em> from underscore).
  function replaceMathRange(entries, range) {
    // Find which text nodes overlap with this range
    var first = -1, last = -1;
    for (var k = 0; k < entries.length; k++) {
      if (entries[k].end > range.start && entries[k].start < range.end) {
        if (first === -1) first = k;
        last = k;
      }
    }
    if (first === -1) return;

    var delim = range.display ? ['\\\\[', '\\\\]'] : ['\\\\(', '\\\\)'];
    // Fix backslashes stripped by remark/micromark CommonMark escape handling.
    // micromark's characterEscape strips \\ before ASCII punctuation, so
    // \\left\\{ becomes \\left{ and \\right\\} becomes \\right} in the DOM.
    // These are never valid KaTeX, so we can safely restore them.
    var fixedLatex = range.latex.replace(/\\\\left\\{/g, '\\\\left\\\\{').replace(/\\\\right\\}/g, '\\\\right\\\\}');
    var replacement = delim[0] + fixedLatex + delim[1];

    if (first === last) {
      // Math is within a single text node - simple case
      var entry = entries[first];
      var node = entry.node;
      var localStart = range.start - entry.start;
      var localEnd = range.end - entry.start;
      var text = node.textContent;
      node.textContent = text.slice(0, localStart) + replacement + text.slice(localEnd);
      return;
    }

    // Math spans multiple text nodes (the common case when remark split it)
    // Strategy: put all content into the first text node, remove intermediate
    // nodes. Only remove element nodes if ALL their text content is within the
    // math range (safe for <em>/<strong> from emphasis, won't touch <a> links
    // unless the entire link text is part of the math expression).
    var firstEntry = entries[first];
    var lastEntry = entries[last];

    // Trim the last text node (content after closing $)
    var lastLocalEnd = range.end - lastEntry.start;
    var afterText = lastEntry.node.textContent.slice(lastLocalEnd);

    // Trim the first text node (content before opening $) and set replacement
    var firstLocalStart = range.start - firstEntry.start;
    var beforeText = firstEntry.node.textContent.slice(0, firstLocalStart);
    firstEntry.node.textContent = beforeText + replacement + afterText;

    // Remove intermediate and last nodes
    for (var k = last; k > first; k--) {
      var ent = entries[k];
      var nodeToRemove = ent.node;
      // If the text node's parent is an inline element (em, strong, etc.)
      // that is entirely within the math range, remove the parent instead
      var parentEl = nodeToRemove.parentElement;
      if (parentEl && /^(EM|STRONG|I|B|DEL|S|SUB|SUP)$/i.test(parentEl.tagName)) {
        // Only remove parent if all its text content is within the math range
        var pStart = -1, pEnd = -1;
        for (var m = 0; m < entries.length; m++) {
          if (parentEl.contains(entries[m].node)) {
            if (pStart === -1) pStart = entries[m].start;
            pEnd = entries[m].end;
          }
        }
        if (pStart >= range.start && pEnd <= range.end && parentEl.parentNode) {
          parentEl.parentNode.removeChild(parentEl);
          continue;
        }
      }
      // Otherwise just remove the text node itself
      if (nodeToRemove.parentNode) {
        nodeToRemove.parentNode.removeChild(nodeToRemove);
      }
    }
  }

  function preprocessMath(el) {
    var blocks = el.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, figcaption');
    if (blocks.length === 0 && el.tagName && /^(P|LI|H[1-6]|TD|TH|DD|DT)$/i.test(el.tagName)) {
      blocks = [el];
    }
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.closest && block.closest('pre, code, .katex, .katex-display')) continue;
      var map = collectTextMap(block);
      if (map.text.indexOf('$') === -1) continue;

      var ranges = findMathRanges(map.text);
      if (ranges.length === 0) continue;

      // Process backwards to preserve text offsets
      for (var r = ranges.length - 1; r >= 0; r--) {
        replaceMathRange(map.entries, ranges[r]);
      }
    }
  }

  function hasMathContent(el) {
    var text = el.textContent || '';
    if (text.indexOf('$$') !== -1) return true;
    if (text.indexOf('\\\\(') !== -1 || text.indexOf('\\\\[') !== -1) return true;
    // Check for potential inline math: text contains at least two $ signs
    var first = text.indexOf('$');
    return first !== -1 && text.indexOf('$', first + 1) !== -1;
  }

  var RENDER_OPTS = {
    delimiters: [
      {left: '$$', right: '$$', display: true},
      {left: '\\\\[', right: '\\\\]', display: true},
      {left: '\\\\(', right: '\\\\)', display: false}
    ],
    throwOnError: false,
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    ignoredClasses: ['katex', 'katex-display']
  };

  function renderElement(el) {
    if (typeof renderMathInElement !== 'function') return;
    // Disconnect observer to prevent cascading mutations during rendering
    messageObserver.disconnect();
    try {
      preprocessMath(el);
      renderMathInElement(el, RENDER_OPTS);
    } catch(e) {
      console.error('[KaTeX Patch] render error:', e);
    }
    // Reconnect observer
    if (activeContainer) {
      messageObserver.observe(activeContainer, { childList: true, subtree: true, characterData: true });
    }
  }

  function renderMath() {
    if (isRendering) return;
    var container = document.querySelector(SELECTOR);
    if (!container) return;

    isRendering = true;
    try {
      renderElement(container);
    } finally {
      isRendering = false;
    }
  }

  // Render dirty assistant messages. Each mutation inside messagesContainer
  // belongs to some assistant message subtree; we collect those, dedupe, and
  // render each one. Rendering is idempotent: renderMathInElement skips .katex
  // nodes via ignoredClasses, and preprocessMath returns early on blocks with
  // no '$'. So re-rendering already-rendered content is effectively free.
  function renderDirtyMessages(mutations) {
    if (isRendering) return;
    if (typeof renderMathInElement !== 'function') return;
    var container = document.querySelector(SELECTOR);
    if (!container) return;

    var dirty = new Set();
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      var el = target.nodeType === 1 ? target : target.parentElement;
      if (!el || !el.isConnected) continue;
      if (el.closest('.katex,.katex-display')) continue;
      var msg = el.closest('[data-testid=\"assistant-message\"]');
      dirty.add(msg || container);
    }

    if (dirty.size === 0) return;

    isRendering = true;
    try {
      dirty.forEach(function(el) { renderElement(el); });
    } finally {
      isRendering = false;
    }
  }

  var pendingMutations = [];
  function debouncedRender(mutations) {
    if (mutations && mutations.length) {
      for (var i = 0; i < mutations.length; i++) pendingMutations.push(mutations[i]);
    }
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(function() {
      var batch = pendingMutations;
      pendingMutations = [];
      if (batch.length > 0) {
        renderDirtyMessages(batch);
      } else {
        renderMath();
      }
    }, 200);
  }

  var messageObserver = new MutationObserver(function(mutations) {
    // Quick filter: only care about added elements or text changes
    var dominated = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0 || mutations[i].type === 'characterData') {
        dominated = true;
        break;
      }
    }
    if (!dominated) return;
    debouncedRender(mutations);
  });

  function observeMessages(container) {
    if (activeContainer === container) return;
    if (activeContainer) messageObserver.disconnect();
    activeContainer = container;
    messageObserver.observe(container, { childList: true, subtree: true, characterData: true });
    // Initial full render for existing content
    renderMath();
  }

  var rootObserver = new MutationObserver(function() {
    var container = document.querySelector(SELECTOR);
    if (container && container !== activeContainer) {
      observeMessages(container);
    }
  });

  function startObserving() {
    var root = document.getElementById('root');
    if (!root) {
      setTimeout(startObserving, 200);
      return;
    }
    rootObserver.observe(root, { childList: true, subtree: true });
    var container = document.querySelector(SELECTOR);
    if (container) {
      observeMessages(container);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }

  // Manual re-render trigger: Ctrl+Alt+M.  Calls renderMath() on the active
  // messagesContainer.  Workaround for issue #6 — if streaming ever leaves
  // a message in a stuck \"raw \\$...\" state, this re-runs the same render
  // pass the debounced observer would have done.
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyM') {
      e.preventDefault();
      e.stopPropagation();
      renderMath();
    }
  }, true);

  // Also expose for programmatic triggers (DevTools, status bar action via
  // a message bus down the road, etc.).
  try { window.__claudeCodeKatexRerender = renderMath; } catch (_) {}

  console.log('[KaTeX Patch] LaTeX rendering enabled');
})();`;
}

// Reloads the Claude Code webview so an on-disk patch change takes effect
// immediately. A webview reload re-fetches the patched bundle (validated on
// real Claude Code); a full window reload is not required. The notification
// keeps manual fallbacks for the rare case the auto-reload did not take:
// "Reload Webview" to retry, "Reload Window" to escalate.
function reloadWebviewAndNotify(message) {
  vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
  vscode.window
    .showInformationMessage(message, 'Reload Webview', 'Reload Window')
    .then(function(choice) {
      if (choice === 'Reload Webview') {
        vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      } else if (choice === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

function activate(context) {
  const vendorDir = path.join(context.extensionPath, 'vendor');

  // Auto-patch on startup.
  // Files stay patched on disk between sessions so the webview always loads
  // the patched version (Claude Code's webview loads before this extension).
  const extDir = findClaudeCodeExtDir();
  if (extDir) {
    try {
      // Patch if unpatched, or refresh if a previous extension version's patch
      // is still in place. The webview already loaded the (un)patched files
      // before this extension activated, so reload it to pick up the change.
      const result = ensurePatched(extDir, vendorDir);
      if (result === 'fresh') {
        reloadWebviewAndNotify('Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.');
      } else if (result === 'refreshed') {
        reloadWebviewAndNotify('Claude Code LaTeX updated. The webview was reloaded; reload again if any math still looks unrendered.');
      }
    } catch (e) {
      console.error('[Claude Code LaTeX] Auto-patch failed:', e);
    }
  } else {
    console.warn('[Claude Code LaTeX] Claude Code extension not found.');
  }

  // Enable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.enable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (isPatched(dir)) {
        vscode.window.showInformationMessage('KaTeX patch is already active.');
        return;
      }
      try {
        applyPatch(dir, vendorDir);
        reloadWebviewAndNotify('Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to apply patch: ' + e.message);
      }
    })
  );

  // Disable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.disable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (!isPatched(dir)) {
        vscode.window.showInformationMessage('KaTeX patch is not active.');
        return;
      }
      try {
        removePatch(dir);
        reloadWebviewAndNotify('Claude Code LaTeX disabled. The webview was reloaded.');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to remove patch: ' + e.message);
      }
    })
  );

  // Status command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.status', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showInformationMessage('Claude Code extension not found.');
        return;
      }
      const patched = isPatched(dir);
      const mode = patched ? (getPatchedMode(dir) || 'v1-fallback') : null;
      const modeLabel = mode === 'v2'
        ? 'remark-math pipeline'
        : mode === 'v1-fallback' ? 'DOM post-processor (fallback)' : '';
      vscode.window.showInformationMessage(
        'Claude Code LaTeX: ' + (patched ? 'Active' : 'Not active') +
        (modeLabel ? ' — ' + modeLabel : '') +
        '\nExtension: ' + dir
      );
    })
  );

  // Manual re-render command.  The injected webview script handles the
  // Ctrl+Alt+M shortcut directly (calls renderMath() in-place).  This
  // palette command is for users who don't know the shortcut: it surfaces
  // the shortcut and offers two heavier fallbacks (reload webview, reload
  // window) because the extension host cannot reach into Claude Code's
  // webview to invoke renderMath() directly.
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.rerender', function() {
      vscode.window.showInformationMessage(
        'Math not rendering? Press Ctrl+Alt+M inside the Claude Code chat to re-render. If math is still stuck, reload the webview or the window.',
        'Reload Webview',
        'Reload Window'
      ).then(function(choice) {
        if (choice === 'Reload Webview') {
          vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        } else if (choice === 'Reload Window') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    })
  );

  // Status bar indicator.  Always visible — text reflects whether the
  // patch is active.  Click runs the rerender command — a single
  // discoverable surface for "the extension is on" + "fix math if stuck".
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'claude-code-katex.rerender';
  function refreshStatusBar() {
    const dir = findClaudeCodeExtDir();
    if (dir && isPatched(dir)) {
      statusBarItem.text = '$(symbol-operator) LaTeX';
      statusBarItem.tooltip =
        'Claude Code LaTeX is active. Click to re-render math (or press Ctrl+Alt+M inside the chat).';
    } else if (dir) {
      statusBarItem.text = '$(symbol-operator) LaTeX (off)';
      statusBarItem.tooltip =
        'Claude Code LaTeX is not patched. Run "Claude Code LaTeX: Enable" or reload after install.';
    } else {
      statusBarItem.text = '$(symbol-operator) LaTeX (no CC)';
      statusBarItem.tooltip = 'Claude Code extension not found.';
    }
  }
  refreshStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Watch for Claude Code extension changes (updates)
  context.subscriptions.push(
    vscode.extensions.onDidChange(function() {
      const dir = findClaudeCodeExtDir();
      if (dir) {
        try {
          // A Claude Code update installs a fresh (unpatched) webview; this
          // re-patches it. It also refreshes a stale patch if one is present.
          const result = ensurePatched(dir, vendorDir);
          if (result === 'fresh' || result === 'refreshed') {
            reloadWebviewAndNotify('Claude Code LaTeX re-applied after a Claude Code update. The webview was reloaded; reload again if any math still looks unrendered.');
          }
        } catch (e) {
          console.error('[Claude Code LaTeX] Re-patch after update failed:', e);
        }
      }
      refreshStatusBar();
    })
  );
}

function deactivate() {
  // Intentionally empty. Files stay patched on disk so Claude Code's webview
  // (which loads before our extension activates) always gets the patched version.
  // Cleanup happens via: "Disable" command, or uninstall-hook.js on uninstall.
}

module.exports = { activate, deactivate };

// Exposed for testing only
module.exports._test = {
  findClaudeCodeExtDir,
  isPatched,
  getPatchedVersion,
  getPatchedMode,
  canRestoreOriginals,
  applyPatch,
  removePatch,
  ensurePatched,
  getMutationObserverScript,
  reloadWebviewAndNotify,
  EXTENSION_VERSION,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
  PATCH_VERSION_PREFIX,
  PATCH_MODE_PREFIX,
  V2_INJECT_RE,
};
