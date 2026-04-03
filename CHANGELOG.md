# Changelog

## [1.6.0] - 2026-04-03

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
