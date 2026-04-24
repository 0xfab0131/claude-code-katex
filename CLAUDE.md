# Claude Code LaTeX Extension

## Architecture

This extension patches Claude Code's webview to add LaTeX rendering via KaTeX.

(Note: display name is "Claude Code LaTeX" but the extension ID and repo name
are still `claude-code-katex` for marketplace continuity.)

**How Claude Code renders chat messages:**
- Uses `react-markdown` (remark/micromark), NOT `marked`
- Custom React components for: `a` (with onClick/onContextMenu handlers for file links), `pre` (wrapped with copy button), `code`, `img`
- `<a>` tags inside `<p>` elements have React event handlers that will be destroyed if you set innerHTML
- remark-gfm is the only plugin (autolink, footnotes, strikethrough, tables, task lists). No remark-math.
- Underscores in LaTeX (e.g. `_{\text{travel}}`) get interpreted as emphasis by micromark, splitting `$...$` across multiple DOM nodes
- **Backslash escaping:** micromark's `characterEscape` tokenizer strips `\` before any ASCII punctuation (`[!-/:-@[-`{-~]`). This means `\{` becomes `{`, `\}` becomes `}`, `\,` becomes `,`, etc. Non-punctuation like `\left`, `\frac`, `\sum` are NOT affected (the `\` survives).
  - **Fixable:** `\left\{` → `\left{` and `\right\}` → `\right}` are patched back by `replaceMathRange()` because `\left{` / `\right}` are never valid KaTeX.
  - **Not fixable:** `\,` (thin space), `\;` (medium space), `\!` (negative space), standalone `\{`/`\}` for literal braces. The backslash is gone from the DOM and the remaining character is ambiguous with legitimate punctuation/grouping. Only a pre-remark hook (e.g. `marked.use()` or remark plugin) could fix these.

**Key constraint:** Never set `innerHTML` on elements that may contain `<a>` tags or other React-managed interactive elements. Use DOM-range-based manipulation instead.

## Before changing the webview patch

Always verify assumptions against the actual compiled Claude Code webview code.

**On Lightning studios, the path that matters is:**
```
~/.local/share/code-server/extensions/anthropic.claude-code-*/webview/index.js
```
**NOT** `~/.vscode-server/extensions/...` (that's a symlink to a separate copy code-server does not load from). Patching the wrong one is the #1 time sink.

Claude Code updates frequently and the internal structure can change. Grep the actual bundle to confirm:
- How markdown is rendered (which library, which plugins)
- What custom React components exist and where interactive elements live
- Whether elements have event handlers that would be destroyed by innerHTML replacement

Do not rely on memory or assumptions about the internals. Read the code.

## Testing

- `node_modules/.bin/jest` runs 73 Jest unit tests (top-level `npm test` sometimes fails with path issues — call the binary directly)
- `node_modules/.bin/playwright test test-ui/ui.spec.js --project=chromium` runs 39 UI tests against a synthetic harness
- **Real E2E** against actual Claude Code + real streaming auth is in `test-ui/verify-fix.js` — see full playbook at `~/.claude/projects/-teamspace-studios-this-studio/memory/vscode-webview-e2e-testing.md` for the checklist of gotchas (webview caching, two extension paths, marker strings, happy-path traps). Read it before doing any hands-on debugging.
- After packaging, install locally and test with actual LaTeX in Claude Code chat

## Packaging

```sh
npx @vscode/vsce package --no-dependencies
code --install-extension claude-code-katex-*.vsix --force
# Then reload VS Code window
```
