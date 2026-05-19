# Changelog

## [2.0.0] - 2026-05-19

### Changed
- **Rendering rewritten.** Math now renders through Claude Code's own react-markdown plugin chain — `remark-math` + `rehype-katex` injected into the markdown pipeline — instead of a DOM post-processor running after render. `remark-math` tokenizes `$...$` / `$$...$$` during markdown parsing, so the LaTeX reaches KaTeX verbatim.

### Fixed
- **Matrices and other multi-row environments now render.** `\\` row separators (in `bmatrix`, `pmatrix`, `vmatrix`, `aligned`, `cases`, `array`, …) were collapsed to a single `\` by Claude Code's markdown parser before v1 ever saw them, so every row merged into one. v2 parses the math before that collapse happens.
- **`\[ ... \]` and `\( ... \)` delimiters now render.** Their backslashes were stripped (`\[` → `[`) before v1 could detect them. v2 normalizes these to `$$` / `$` ahead of parsing (fenced code blocks are left untouched).
- Multi-line display math containing a line that is only `=` no longer renders as a giant heading (a CommonMark setext-heading mis-parse).
- Backslash-escaped braces (`\{`, `\}`) and spacing macros (`\,`, `\;`, `\!`, `\:`) inside math now survive. v1's CommonMark layer stripped the backslash (`\;` → `;`, `\!` → `!`) before KaTeX saw it. ([#7](https://github.com/MahammadNuriyev62/claude-code-katex/issues/7))
- Underscore subscripts that CommonMark parsed as emphasis (`_..._` → `<em>`, dropping the `_`) are preserved — v2 parses the math before emphasis parsing runs. ([#7](https://github.com/MahammadNuriyev62/claude-code-katex/issues/7))

### Removed
- The MutationObserver / debounce / streaming re-render machinery. Rendering is now part of React's render pass, so there is no flash of raw `$` during streaming and no `Ctrl+Alt+M` re-render needed.

### Notes
- If a future Claude Code build changes its bundle shape so the injection point is not found, the extension automatically falls back to the v1 DOM post-processor, so rendering keeps working.

## [1.10.1] - 2026-05-19

### Added
- Animated demo GIF in the README and Marketplace listing. It walks through raw `$$...$$` in a Claude Code response, installing the extension, and the same math rendering live.

## [1.10.0] - 2026-05-15

### Fixed
- Updating the extension now refreshes the code injected into Claude Code's webview. Previously the patch was version-agnostic, so an extension update kept the old injected code in place until Claude Code itself next updated. The patch now carries a version stamp; on activation a newer build detects an older or unstamped patch, restores the original webview files from backup, and re-applies the current patch. The refresh is guarded so it can never produce a double patch.

## [1.9.0] - 2026-05-15

### Changed
- The webview now reloads automatically when the patch is applied or removed (on startup, Enable, Disable, or after a Claude Code update). LaTeX rendering starts or stops without any manual reload.
- The confirmation notification keeps "Reload Webview" and "Reload Window" buttons as fallbacks, for the rare case the automatic reload does not take effect.

## [1.8.0] - 2026-05-14

### Added
- Manual re-render trigger for issue #6 ("Math expressions sometimes remain as raw `$...$` during streaming until the window is reloaded"):
  - **Keyboard shortcut `Ctrl+Alt+M`** inside the Claude Code chat re-runs the render pass on the active message container.
  - **Command palette entry** "Claude Code LaTeX: Re-render Math" surfaces the shortcut and offers "Reload Webview" / "Reload Window" as heavier fallbacks.
  - **Status bar indicator** ("$(symbol-operator) LaTeX") always visible when Claude Code is patched. Clicking it triggers the rerender command.
  - `window.__claudeCodeKatexRerender` bridge exposed inside the webview for programmatic re-renders.

## [1.7.6] - 2026-04-21

### Changed
- README updated to match "Claude Code LaTeX" naming (marketplace page).

## [1.7.5] - 2026-04-21

### Fixed
- Package size regression: 1.7.4 accidentally bundled development directories and ballooned to 17 MB. Restored to ~1 MB.

## [1.7.4] - 2026-04-21

### Changed
- Command palette entries now say "Claude Code LaTeX: Enable / Disable / Status" (previously "KaTeX").
- Status messages and console logs updated to match.

## [1.7.3] - 2026-04-21

### Changed
- Display name simplified to "Claude Code LaTeX". KaTeX is an implementation detail.

## [1.7.2] - 2026-04-21

### Fixed
- Streaming messages with multiple math expressions now render all math, not just the last paragraph. Previously, rapid `characterData` mutations during streaming would overwrite the debounce closure's `mutations` argument, so only the last batch was processed — most paragraphs' math was never rendered and the message stayed as raw `$...$` until the user reloaded the window.

### Changed
- `renderNewNodes` replaced by `renderDirtyMessages`, which walks up from each mutation target to its `[data-testid="assistant-message"]` ancestor and renders the whole message. Handles characterData mutations, text-node additions, and element additions uniformly. No more `nodeType === 1` filter that silently skipped text-node additions.
- Mutations now accumulate across debounce callbacks (`pendingMutations`) instead of the closure capturing only the latest batch.

## [1.7.1] - 2026-04-03

### Added
- DOM-range-based math preprocessing that correctly handles LaTeX split across multiple DOM nodes by remark's emphasis parsing (e.g. `$\tilde{T}_{\text{travel}}^{(k)}$`)
- Incremental rendering: only newly added/changed nodes are processed, not the entire chat container
- Observer disconnect/reconnect during rendering to prevent cascading mutation crashes

### Fixed
- `\left\{` and `\right\}` curly brace delimiters now render correctly. Claude Code's markdown parser (micromark) strips backslashes before punctuation, turning `\left\{` into invalid `\left{`. The extension now detects and restores these.
- Eliminated `removeChild` crash caused by MutationObserver firing during DOM manipulation

### Changed
- Replaced innerHTML-based preprocessing with surgical DOM node replacement, preserving React event handlers on `<a>` tags and other interactive elements

## [1.5.0] - 2026-03-28

### Added
- Pandoc `tex_math_dollars` rules for `$` disambiguation (currency vs math)
- 27 edge-case tests for dollar sign handling

### Fixed
- Currency amounts like `$5` and `$10` no longer incorrectly trigger math rendering

## [1.4.2] - 2026-03-27

### Fixed
- Always prompt reload when activate() re-patches files after disable/enable cycle

## [1.4.0] - 2026-03-27

### Added
- 65 Jest tests covering extension lifecycle, patching, and observer behavior
- Scoped KaTeX rendering to messages container instead of entire `#root`

## [1.0.0] - 2026-03-26

### Added
- Initial release
- KaTeX rendering for `$...$` (inline) and `$$...$$` (display) math in Claude Code chat
- Auto-patch on startup with backup/restore
- MutationObserver for live rendering of streamed responses
- Commands: Enable, Disable, Check Status
- Clean uninstall hook
