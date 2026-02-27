// Webview-side entry point — full UI layout (Phase 0)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const acquireVsCodeApi: () => any;
const vscode = acquireVsCodeApi();

// ── DOM bootstrap ────────────────────────────────────────────────────────────

const root = document.getElementById('root')!;
root.innerHTML = `
<div id="app">
  <div id="toolbar">
    <button id="btn-new-session" title="New session">New Session</button>
    <button id="btn-attach" title="Attach files">Attach Files</button>
  </div>

  <ul id="attached-files"></ul>

  <div id="output" aria-live="polite"></div>

  <div id="status-bar"></div>

  <div id="input-row">
    <textarea id="prompt-input" rows="4" placeholder="Ask the agent…"></textarea>
    <div id="input-buttons">
      <button id="btn-send">Send</button>
      <button id="btn-stop" disabled>Stop</button>
    </div>
  </div>
</div>
`;

// Inline styles — keeps the webview self-contained (no external CSS file needed)
const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, #1e1e1e);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  #app {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 6px;
    gap: 6px;
  }

  #toolbar {
    display: flex;
    gap: 4px;
  }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 2px;
    font-size: inherit;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.45; cursor: default; }

  #attached-files {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-height: 0;
  }

  #attached-files li {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  #attached-files li button {
    background: none;
    color: inherit;
    padding: 0 2px;
    font-size: 11px;
    line-height: 1;
    opacity: 0.7;
  }
  #attached-files li button:hover { opacity: 1; }

  #output {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--vscode-widget-border, #444);
    padding: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    border-radius: 2px;
    min-height: 60px;
  }

  #status-bar {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-height: 16px;
  }

  #input-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  #prompt-input {
    width: 100%;
    resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 6px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
  }
  #prompt-input:focus { outline: 1px solid var(--vscode-focusBorder); }

  #input-buttons {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
`;
document.head.appendChild(style);

// ── Element refs ─────────────────────────────────────────────────────────────

const outputEl     = document.getElementById('output')!;
const promptInput  = document.getElementById('prompt-input') as HTMLTextAreaElement;
const btnSend      = document.getElementById('btn-send') as HTMLButtonElement;
const btnStop      = document.getElementById('btn-stop') as HTMLButtonElement;
const btnAttach    = document.getElementById('btn-attach') as HTMLButtonElement;
const btnNewSess   = document.getElementById('btn-new-session') as HTMLButtonElement;
const filesList    = document.getElementById('attached-files') as HTMLUListElement;
const statusBar    = document.getElementById('status-bar')!;

// ── State ────────────────────────────────────────────────────────────────────

interface AttachedFile { uri: string; relativePath: string; }

let attachedFiles: AttachedFile[] = [];
let isGenerating = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  statusBar.textContent = text;
}

function appendOutput(text: string): void {
  outputEl.textContent += text;
  outputEl.scrollTop = outputEl.scrollHeight;
}

function setGenerating(active: boolean): void {
  isGenerating = active;
  btnSend.disabled = active;
  btnStop.disabled = !active;
  promptInput.disabled = active;
}

function renderAttachedFiles(): void {
  filesList.innerHTML = '';
  for (const f of attachedFiles) {
    const li = document.createElement('li');
    const label = document.createTextNode(f.relativePath);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      attachedFiles = attachedFiles.filter(a => a.uri !== f.uri);
      renderAttachedFiles();
    });
    li.appendChild(label);
    li.appendChild(removeBtn);
    filesList.appendChild(li);
  }
}

// ── Event handlers ───────────────────────────────────────────────────────────

btnSend.addEventListener('click', sendPrompt);

promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendPrompt();
  }
});

btnStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
  setGenerating(false);
  setStatus('Cancelled.');
});

btnAttach.addEventListener('click', () => {
  vscode.postMessage({ type: 'attachFiles' });
});

btnNewSess.addEventListener('click', () => {
  outputEl.textContent = '';
  attachedFiles = [];
  renderAttachedFiles();
  setStatus('');
  vscode.postMessage({ type: 'newSession' });
});

function sendPrompt(): void {
  const prompt = promptInput.value.trim();
  if (!prompt || isGenerating) { return; }
  outputEl.textContent = '';
  setStatus('');
  setGenerating(true);
  vscode.postMessage({ type: 'send', prompt });
  promptInput.value = '';
}

// ── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as {
    type: string;
    content?: string;
    text?: string;
    message?: string;
    files?: AttachedFile[];
  };

  switch (msg.type) {
    case 'delta':
      appendOutput(msg.content ?? '');
      break;

    case 'done':
      setGenerating(false);
      setStatus('Done.');
      break;

    case 'error':
      setGenerating(false);
      setStatus(`Error: ${msg.message ?? 'unknown'}`);
      break;

    case 'status':
      setStatus(msg.text ?? '');
      break;

    case 'attachments':
      if (msg.files) {
        attachedFiles = msg.files.map(f => ({ uri: f.uri, relativePath: f.relativePath }));
        renderAttachedFiles();
      }
      break;
  }
});

export {};
