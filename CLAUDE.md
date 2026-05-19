# Claude Code LaTeX Extension

## Architecture

This extension patches Claude Code's webview to render LaTeX math via KaTeX.

(Display name is "Claude Code LaTeX"; the extension ID and repo name are still
`claude-code-katex` for marketplace continuity.)

The extension injects a math pipeline into Claude Code's own react-markdown
plugin chain, so math is tokenized *during* Markdown parsing — verbatim —
instead of being repaired in the DOM afterward.

- `applyPatch` (in `extension.js`) locates Claude Code's single react-markdown
  call — `createElement(<Markdown>, {remarkPlugins:[<gfm>], components:{...}},
  text)` — with `V2_INJECT_RE`, and rewrites it to add
  `rehypePlugins:[rehypeKatex]` and `remarkPlugins:[gfm, remarkBracketMath,
  remarkMath]`. The injected references are guarded on `window.__KATEX_V2_LOADED`
  so a bundle-load failure cannot break Claude Code's Markdown.
- It prepends `vendor/katex.min.js` + `vendor/remark-math-bundle.js` to the
  webview bundle (Claude Code mounts its React app at the end of the bundle, so
  the globals must be defined first).
- If the injection point is not found — a future Claude Code reshaped its
  bundle — `applyPatch` returns `false`, touches nothing, and the extension
  shows an "update / report an issue" notice. There is no fallback renderer.

The patch is version-stamped; an extension update restores the originals from
`.katex-bak` and re-applies. Claude Code's `extension.js` is **never modified** —
only the webview bundle (an isolated browser context) is patched.

## The math pipeline — `v2-spike/entry.js`

`remark-math` only recognizes `$...$` / `$$...$$`. `remarkBracketMath` wraps the
Markdown parser to normalize the raw source before micromark runs:

- `\[`→`$$`, `\]`→`$$`, `\(`→`$`, `\)`→`$` — each guarded with `(?<!\\)` so
  amsmath row separators like `\\[6pt]` keep their `[` and are not corrupted.
- currency `$`+digit → `\$` (so `$5` is not treated as math).
- a `$$` display fence that shares its line with content (`$$\begin{aligned}` /
  `\end{aligned}$$`) is moved onto its own line — remark-math's display-math
  flow construct only recognizes `$$` alone on a line.
- fenced code blocks are skipped.

After editing `entry.js`, rebuild the shipped bundle:

```sh
npm run build:bundle
```

(esbuild IIFE; KaTeX is externalized to `window.katex` via
`v2-spike/katex-global-shim.js`.)

## Where Claude Code lives

The extension auto-locates Claude Code via the `anthropic.claude-code` extension
id, so normal use needs no paths. For manual inspection, the extension folder is
under the VS Code extensions directory, which varies by setup:

- `~/.vscode/extensions/` — desktop VS Code
- `~/.vscode-server/extensions/` — Remote-SSH, WSL, Dev Containers, Codespaces
- `~/.local/share/code-server/extensions/` — code-server / browser VS Code

If more than one VS Code is in play, install into and test the instance you
actually use: plain `code --install-extension` targets your default desktop VS
Code; a remote or code-server instance has its own CLI.

## Before changing the webview patch

Verify against the actual compiled Claude Code webview bundle —
`webview/index.js` of the installed `anthropic.claude-code-*` extension. Claude
Code updates frequently and can reshape its bundle, so confirm the injection
point still matches before relying on it.

## Setup

`npm install` first (Node 18+) — it provides `jest`, `esbuild` (for the bundle
build), and `playwright`.

## Testing

You verify changes yourself before committing. Run levels 1–2 for any change;
level 3 for anything that affects rendering.

### Level 1 — unit tests (no browser)

```sh
node_modules/.bin/jest
```

Covers the patch lifecycle (apply / refresh / remove) and the webview injection.
Call the binary directly; `npm test` can hit path issues.

### Level 2 — rendering harness (needs a browser)

`v2-spike/test.html` renders the real shipping bundle
(`vendor/remark-math-bundle.js`) through Claude Code's actual plugin chain
(`react-markdown` → `remark-math` → `rehype-katex`) and records a PASS/FAIL per
case on `window.__RESULTS` (`window.__DONE` flags completion).

It is a browser page, so you drive a browser to run it: serve the repo
(`python3 -m http.server 8080` — the harness loads `/vendor/…` by absolute path
and pulls React from a CDN, so it needs network access), then via Playwright or
the Playwright MCP server open `http://localhost:8080/v2-spike/test.html`, wait
for `window.__DONE`, and read `window.__RESULTS`. Add a case to `test.html` for
every rendering bug you fix.

### Level 3 — real end-to-end (heaviest; needs a set-up environment)

The truest check — the real extension patching a real Claude Code — and the
only level with real prerequisites. You need a **browser-drivable VS Code**
(code-server; a desktop Electron VS Code can't be driven this way) running a
Claude Code extension that is **installed and signed in**. That is a one-time
setup cost — treat level 3 as a pre-release / maintainer check, not something
every change needs.

Build, package, install:

```sh
npm run build:bundle                          # rebuild if entry.js changed
npx @vscode/vsce package --no-dependencies     # -> claude-code-katex-<ver>.vsix
code --install-extension claude-code-katex-<ver>.vsix --force
```

Then drive that code-server through Playwright / the MCP server: reload the
window, open a Claude Code tab, find its webview iframe **by shape** (it has
`#root` and a message input — do not match on URL), send a math prompt, and
assert `.katex` elements render with no `.katex-error`. Exercise inline `$…$` /
`\(…\)`, display `$$…$$` / `\[…\]`, matrices, multi-line environments, and
confirm code blocks and currency (`$5`) stay literal.

The patched `webview/index.js` carries a `katex-ext-version: <x.y.z>` stamp;
`webview/index.js.katex-bak` is the pristine backup.

### Browser automation (levels 2 and 3)

You operate and observe the harness and VS Code through a real browser, not
directly. Use either:

- the `playwright` package (a devDependency) — run `npx playwright install
  chromium` once for the browser binary, then drive it from a Node script via
  Bash; or
- the **Playwright MCP server**, if it is configured for your session.

Level 1 needs neither.

## Submitting changes

- Rebuild and commit `vendor/remark-math-bundle.js` whenever you change
  `entry.js`.
- Run levels 1–2 before committing; run level 3 for rendering changes.
- Add a `v2-spike/test.html` regression case for any bug you fix.
- Keep commit messages in the existing style (`fix:`, `feat:`, `test:`,
  `docs:`, …).
