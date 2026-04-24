# test-ui/

Two test tiers. Run all tests with `npm run test:ui`. Debug tools are only invoked manually.

## Tier 1 — Synthetic Playwright tests (fast, deterministic, run in CI)

Drive a local HTTP server + Chromium against a synthetic harness. No VS Code, no API keys, no live Claude Code.

- **`ui.spec.js`** + **`harness.html`** — 39 tests. Initial rendering, input isolation, currency vs. math disambiguation, dynamic injection, container replacement, selector robustness. The canonical regression suite.
- **`streaming.spec.js`** + **`streaming-harness.html`** — three synthetic streaming DOM-mutation patterns (innerHTML swap, `textContent` update, `appendChild` text nodes) against the real KaTeX observer script extracted from `extension.js`. Catches the specific debounce-closure bug that v1.7.2 fixed.
- **`react-streaming.spec.js`** + **`react-streaming-harness.html`** + **`react-harness-entry.js`** — the most faithful synthetic test: real `react-markdown` + real `remark-gfm` bundled via esbuild (single React instance) so DOM mutation patterns match Claude Code's webview within a margin. Build step:
  ```
  npx esbuild test-ui/react-harness-entry.js --bundle \
    --outfile=test-ui/react-harness-bundle.js --format=iife \
    --target=es2020 --define:process.env.NODE_ENV='"production"'
  ```
  Bundle is gitignored.

## Tier 2 — Real-VSCode E2E (slow, touches live Claude Code, API-key-dependent)

Drive Lightning.ai's code-server (already running on `:30110`) via Playwright, using the user's Claude Code auth. See `~/.claude/projects/-teamspace-studios-this-studio/memory/vscode-webview-e2e-testing.md` for the full playbook.

- **`verify-fix.js`** — minimal "does the fix work end-to-end" runner. Opens Claude Code, sends the user's repro prompt (`generate some latex equations`), polls for rendered math, prints `✅` or `❌`. Use this to sanity-check any change to `extension.js` before releasing.
- **`real-vscode-new-chat.js`** — instrumented version of the above. Installs a `MutationObserver` wrapper to log mutation types/timings, captures screenshots at intervals during streaming, compares pre/post-reload state. Heavier but reveals *why* something renders (or doesn't).

## Debug tools (manual only — no tests)

Run these from the repo root with `node test-ui/<file>` when something isn't working.

- **`fetch-webview-src.js`** — the single most useful diagnostic. Opens the webview, finds its `index.js` script tag, fetches what VS Code is actually serving, and compares against the on-disk file. If the served content doesn't match disk, you're hitting the service-worker cache or the two-extension-paths issue.
- **`probe-frames.js`** — dumps every iframe's URL + structure after opening Claude Code. Use when `getClaudeFrame()` stops finding the webview (e.g., Claude Code ships a DOM change).
- **`probe-version.js`** — checks `window.__KATEX_VERSION` inside the webview to confirm which patched version is running. Pair with a marker string injected at patch time.
