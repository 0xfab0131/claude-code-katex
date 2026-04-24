// Entry point for a real react-markdown streaming harness.
// Bundled with esbuild so there's exactly ONE React copy.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

let currentRoot = null;
let currentSetter = null;

function AssistantBubble({ text }) {
  return React.createElement(
    Markdown,
    {
      remarkPlugins: [remarkGfm],
      components: {
        // Mimic Claude Code's <a> handlers so the DOM has React event handlers
        a: (props) =>
          React.createElement('a', {
            ...props,
            onClick: (e) => e.preventDefault(),
            onContextMenu: (e) => e.preventDefault(),
          }),
      },
    },
    text
  );
}

function Root() {
  const [text, setText] = React.useState('');
  currentSetter = setText;
  return React.createElement(AssistantBubble, { text });
}

function beginAssistantMessage() {
  if (currentRoot) {
    currentRoot.unmount();
    currentRoot = null;
    currentSetter = null;
  }
  const container = document.getElementById('messages');
  const turn = document.createElement('div');
  turn.className = 'turn_07S1Yg';
  const msg = document.createElement('div');
  msg.className = 'message_07S1Yg assistant';
  msg.setAttribute('data-testid', 'assistant-message');
  turn.appendChild(msg);
  container.appendChild(turn);
  currentRoot = createRoot(msg);
  currentRoot.render(React.createElement(Root));
  return msg;
}

async function streamReact(fullText, chunk = 2, delay = 30) {
  beginAssistantMessage();
  // Wait for first render so setter is ready.
  for (let i = 0; i < 100 && !currentSetter; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!currentSetter) throw new Error('setter not ready');
  let acc = '';
  for (let i = 0; i < fullText.length; i += chunk) {
    acc += fullText.slice(i, i + chunk);
    currentSetter(acc);
    await new Promise((r) => setTimeout(r, delay));
  }
  const status = document.getElementById('status');
  if (status) status.textContent = 'react done, len=' + acc.length;
}

window.__streamReact = streamReact;
window.__beginAssistantReact = beginAssistantMessage;
window.__resetAssistant = () => {
  [...document.querySelectorAll('.turn_07S1Yg:not(#initial-turn)')].forEach((el) => el.remove());
  if (currentRoot) {
    try { currentRoot.unmount(); } catch (_) {}
    currentRoot = null;
    currentSetter = null;
  }
};
window.__reactReady = true;
const status = document.getElementById('status');
if (status) status.textContent = 'react-markdown (npm) loaded, ready';
