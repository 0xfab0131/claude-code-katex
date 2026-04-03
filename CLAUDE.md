# Claude Code KaTeX Extension

## Architecture

This extension patches Claude Code's webview to add LaTeX rendering via KaTeX.

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

Always verify assumptions against the actual compiled Claude Code webview code at:
```
~/.vscode-server/extensions/anthropic.claude-code-*/webview/index.js
```

Claude Code updates frequently and the internal structure can change. Grep the actual bundle to confirm:
- How markdown is rendered (which library, which plugins)
- What custom React components exist and where interactive elements live
- Whether elements have event handlers that would be destroyed by innerHTML replacement

Do not rely on memory or assumptions about the internals. Read the code.

## Testing

- `npm test` runs 69 Jest tests for the extension logic
- DOM behavior tests should use jsdom to simulate react-markdown output (text split across `<em>` tags, `<a>` tags with handlers, etc.)
- After packaging, install locally and test with actual LaTeX in Claude Code chat

## Packaging

```sh
npx @vscode/vsce package --no-dependencies
code --install-extension claude-code-katex-*.vsix --force
# Then reload VS Code window
```
