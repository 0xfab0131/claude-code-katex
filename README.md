# Claude Code KaTeX

Adds LaTeX math rendering to the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) VSCode extension using [KaTeX](https://katex.org/).

Temporary workaround for [anthropics/claude-code#16446](https://github.com/anthropics/claude-code/issues/16446) until native LaTeX rendering is added.

Renders `$...$` (inline) and `$$...$$` (display) math expressions in Claude's chat responses.

## Demo

| Before | After |
|--------|-------|
| <img width="505" alt="Image" src="https://github.com/user-attachments/assets/4813f18c-fcaa-419f-a636-a8c3651f8ec4" /> | <img width="503" alt="Image" src="https://github.com/user-attachments/assets/a26b6b99-9e0c-4643-8467-549134068ee4" /> |

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

## Disabling / Uninstalling

To **temporarily disable** LaTeX rendering, use the command:

`Ctrl+Shift+P` → **Claude Code KaTeX: Disable LaTeX Rendering** → reload when prompted.

To **re-enable**, use **Claude Code KaTeX: Enable LaTeX Rendering**.

**Uninstalling** the extension from the Extensions panel automatically cleans up the patch.

> **Why not the Disable button in the Extensions panel?** The patch lives in Claude Code's webview files on disk. Claude Code loads its webview before this extension activates, so if we removed the patch on deactivate, the webview would load unpatched files before we could re-apply. Keeping files patched on disk ensures it works reliably across restarts.

## Known Limitations

- **Backslash spacing commands** (`\,` `\;` `\!`) are stripped by Claude Code's markdown parser before this extension sees them. There is no workaround at this time.
- After Claude Code updates, you may need to reload the window once for the re-patch to take effect.
- There may be a brief flash of raw LaTeX during streaming responses (200ms debounce).
- Code blocks are never affected. `$variable` inside `` `code` `` or code fences is left alone.
- This is a temporary workaround until [anthropics/claude-code#16446](https://github.com/anthropics/claude-code/issues/16446) is resolved. Once Claude Code ships native LaTeX support, this extension can be uninstalled.

## Bugs & Feedback

Found a rendering issue? Something not displaying correctly?

Please [open an issue](https://github.com/MahammadNuriyev62/claude-code-katex/issues/new) with:
- The LaTeX expression that failed
- A screenshot of how it rendered (or didn't)
- Your VS Code and Claude Code extension versions

Every report helps improve the extension for everyone.

## License

MIT
