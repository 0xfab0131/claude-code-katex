# Claude Code KaTeX

Adds LaTeX math rendering to the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) VSCode extension using [KaTeX](https://katex.org/).

Temporary workaround for [anthropics/claude-code#16446](https://github.com/anthropics/claude-code/issues/16446) until native LaTeX rendering is added.

Renders `$...$` (inline) and `$$...$$` (display) math expressions in Claude's chat responses.

## Install

### From VS Code Marketplace

Search for **"Claude Code KaTeX"** in the Extensions tab, or:

```bash
code --install-extension nuriyev.claude-code-katex
```

### From .vsix file

1. Download the latest `.vsix` from [Releases](https://github.com/MahammadNuriyev62/claude-code-katex/releases)
2. In VSCode: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Reload when prompted

## Usage

The extension patches Claude Code automatically on startup. If you need manual control:

- `Ctrl+Shift+P` → **Claude Code KaTeX: Enable LaTeX Rendering**
- `Ctrl+Shift+P` → **Claude Code KaTeX: Disable LaTeX Rendering**
- `Ctrl+Shift+P` → **Claude Code KaTeX: Check Status**

## How it works

On activation, the extension appends KaTeX (core + auto-render + a MutationObserver) to Claude Code's webview files. A MutationObserver watches for new chat content and renders any LaTeX expressions it finds. Code blocks are ignored.

When Claude Code updates, the patch is automatically re-applied.

`extension.js` of Claude Code is **never modified**. Only the webview bundle (which runs in an isolated browser context) is patched, and originals are backed up.

## Notes

- After Claude Code updates, you may need to reload the window once for the re-patch to take effect.
- There may be a brief flash of raw LaTeX during streaming responses (200ms debounce).
- This is a temporary workaround until [anthropics/claude-code#16446](https://github.com/anthropics/claude-code/issues/16446) is resolved. Once Claude Code ships native LaTeX support, this extension can be uninstalled.

## License

MIT
