// v2 webview bundle entry.
//
// Bundles the remark-math + rehype-katex pipeline and exposes the three
// plugins as globals. The extension's patch injects them into Claude Code's
// react-markdown call:
//
//   createElement(Markdown, { remarkPlugins: [gfm], components: {...} }, text)
//        -> remarkPlugins: [gfm, __remarkBracketMath, __remarkMath]
//           rehypePlugins: [__rehypeKatex]
//
// Why this fixes what v1 could not: remark-math tokenises $...$ / $$...$$
// during micromark tokenisation, capturing the LaTeX verbatim BEFORE
// CommonMark's characterEscape collapses `\\` (matrix row breaks) and before
// block parsing can mis-read a lone `=` line as a setext heading.
//
// `katex` is externalised to the global shim — v1's vendored katex.min.js
// already defines window.katex.
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// --- \[ \] and \( \) support, plus currency disambiguation ----------------
//
// remark-math only knows $ and $$. Claude also emits \[...\] (display) and
// \(...\) (inline). Those delimiters are NOT recoverable after micromark runs
// (`\[` -> `[`), so we normalise them on the raw markdown string, before the
// parser sees it, by wrapping the parser. Fenced code blocks are left alone.
function normalizeMathDelims(src) {
  if (typeof src !== 'string') return src;
  if (src.indexOf('\\') === -1 && src.indexOf('$') === -1) return src;
  const lines = src.split('\n');
  let inFence = false, fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (fence[1][0] === fenceChar) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    lines[i] = lines[i]
      // currency: a lone `$` immediately before a digit ($100, $5) is not math
      .replace(/(?<![$\\])\$(?!\$)(?=\d)/g, '\\$')
      // \[ \] -> $$   (display);   \( \) -> $   (inline)
      .replace(/\\\[/g, '$$$$').replace(/\\\]/g, '$$$$')
      .replace(/\\\(/g, '$').replace(/\\\)/g, '$');
  }
  return lines.join('\n');
}

// A remark plugin that wraps the parser so normalizeMathDelims runs on the
// raw document string. remark-parse has already set this.parser by the time
// remark plugins are applied.
function remarkBracketMath() {
  const parser = this.parser;
  if (typeof parser === 'function') {
    this.parser = (doc, file) => parser(normalizeMathDelims(doc), file);
  }
}

window.__remarkMath = remarkMath && remarkMath.default ? remarkMath.default : remarkMath;
window.__rehypeKatex = rehypeKatex && rehypeKatex.default ? rehypeKatex.default : rehypeKatex;
window.__remarkBracketMath = remarkBracketMath;
window.__KATEX_V2_LOADED = true;
console.log('[Claude Code LaTeX v2] math pipeline loaded:',
  typeof window.__remarkMath, typeof window.__rehypeKatex, typeof window.__remarkBracketMath);
