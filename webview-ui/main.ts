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

// ── Approval card ─────────────────────────────────────────────────────────────

const approvalStyle = `
  .approval-card {
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    border-radius: 3px;
    padding: 8px 10px;
    margin: 6px 0;
    font-size: 12px;
  }
  .approval-card .approval-title {
    font-weight: bold;
    margin-bottom: 4px;
    color: var(--vscode-foreground);
  }
  .approval-card .approval-reason {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }
  .approval-card .approval-preview {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 2px;
    padding: 4px 6px;
    margin-bottom: 6px;
    word-break: break-all;
    white-space: pre-wrap;
  }
  .approval-card .approval-preview .preview-label {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
  .approval-card .approval-preview .preview-arrow {
    color: var(--vscode-descriptionForeground);
    margin: 2px 0;
  }
  .approval-card .approval-buttons {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .approval-card .btn-approve {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .approval-card .btn-deny {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  .approval-card .btn-approve-always {
    background: transparent;
    color: var(--vscode-textLink-foreground, #4e9fde);
    border: none;
    font-size: 11px;
    padding: 0 4px;
    cursor: pointer;
    text-decoration: underline;
    margin-left: auto;
  }
  .approval-card .btn-approve-always:hover {
    color: var(--vscode-textLink-activeForeground, #6bb3f0);
  }
`;
const approvalStyleEl = document.createElement('style');
approvalStyleEl.textContent = approvalStyle;
document.head.appendChild(approvalStyleEl);

// Container for approval cards — inserted before the input row
const appEl = document.getElementById('app')!;
const inputRowEl = document.getElementById('input-row')!;
const approvalsContainer = document.createElement('div');
approvalsContainer.id = 'approvals-container';
appEl.insertBefore(approvalsContainer, inputRowEl);

// Actions auto-approved for this session (populated by "Approve & Don't ask again")
const sessionAutoApproved = new Set<string>();

type ApprovalPayload = {
  path?: string;
  command?: string;
  from?: string;
  to?: string;
};

// Actions that are non-destructive enough to offer "Don't ask again"
const NON_DESTRUCTIVE_ACTIONS = new Set(['moveFile', 'applyEdit']);

function buildPreviewEl(action: string, payload: ApprovalPayload | undefined): HTMLElement {
  const preview = document.createElement('div');
  preview.className = 'approval-preview';

  if (action === 'runCommand') {
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'Command';
    const cmd = document.createElement('div');
    cmd.textContent = payload?.command ?? '';
    preview.appendChild(label);
    preview.appendChild(cmd);
  } else if (action === 'moveFile') {
    const fromLabel = document.createElement('div');
    fromLabel.className = 'preview-label';
    fromLabel.textContent = 'From';
    const fromVal = document.createElement('div');
    fromVal.textContent = payload?.from ?? payload?.path ?? '';
    const arrow = document.createElement('div');
    arrow.className = 'preview-arrow';
    arrow.textContent = '↓';
    const toLabel = document.createElement('div');
    toLabel.className = 'preview-label';
    toLabel.textContent = 'To';
    const toVal = document.createElement('div');
    toVal.textContent = payload?.to ?? '';
    preview.appendChild(fromLabel);
    preview.appendChild(fromVal);
    preview.appendChild(arrow);
    preview.appendChild(toLabel);
    preview.appendChild(toVal);
  } else if (action === 'deleteFile') {
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'File (will be moved to trash)';
    const val = document.createElement('div');
    val.textContent = payload?.path ?? '';
    preview.appendChild(label);
    preview.appendChild(val);
  } else {
    // applyEdit or unknown
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'File';
    const val = document.createElement('div');
    val.textContent = payload?.path ?? action;
    preview.appendChild(label);
    preview.appendChild(val);
  }

  return preview;
}

function getActionTitle(action: string): string {
  switch (action) {
    case 'runCommand': return 'Run terminal command?';
    case 'moveFile':   return 'Move file?';
    case 'deleteFile': return 'Delete file?';
    case 'applyEdit':  return 'Apply edit to file?';
    default:           return `Approve: ${action}?`;
  }
}

function getApproveLabel(action: string): string {
  switch (action) {
    case 'runCommand': return 'Run';
    case 'deleteFile': return 'Delete';
    default:           return 'Approve';
  }
}

function showApprovalCard(
  approvalId: string,
  action: string,
  payload: ApprovalPayload | undefined,
  reason: string
): void {
  // If this action was auto-approved for the session, respond immediately
  if (sessionAutoApproved.has(action)) {
    vscode.postMessage({ type: 'approval/response', approvalId, approved: true });
    return;
  }

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = approvalId;

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = getActionTitle(action);

  if (reason) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'approval-reason';
    reasonEl.textContent = reason;
    card.appendChild(title);
    card.appendChild(reasonEl);
  } else {
    card.appendChild(title);
  }

  card.appendChild(buildPreviewEl(action, payload));

  const buttons = document.createElement('div');
  buttons.className = 'approval-buttons';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn-approve';
  approveBtn.textContent = getApproveLabel(action);
  approveBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approval/response', approvalId, approved: true });
    card.remove();
  });

  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn-deny';
  denyBtn.textContent = 'Deny';
  // Default focus: Deny (safer default)
  denyBtn.autofocus = true;
  denyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approval/response', approvalId, approved: false });
    card.remove();
  });

  buttons.appendChild(approveBtn);
  buttons.appendChild(denyBtn);

  // "Approve & Don't ask again this session" — only for non-destructive actions
  if (NON_DESTRUCTIVE_ACTIONS.has(action)) {
    const alwaysBtn = document.createElement('button');
    alwaysBtn.className = 'btn-approve-always';
    alwaysBtn.textContent = "Approve & don't ask again this session";
    alwaysBtn.addEventListener('click', () => {
      sessionAutoApproved.add(action);
      vscode.postMessage({ type: 'approval/response', approvalId, approved: true });
      card.remove();
    });
    buttons.appendChild(alwaysBtn);
  }

  card.appendChild(buttons);
  approvalsContainer.appendChild(card);

  // Focus the deny button so keyboard users default to the safe choice
  denyBtn.focus();
}

// ── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as {
    type: string;
    content?: string;
    text?: string;
    message?: string;
    files?: AttachedFile[];
    approvalId?: string;
    action?: string;
    payload?: unknown;
    reason?: string;
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

    case 'approval/request': {
      const payload = msg.payload as ApprovalPayload | undefined;
      showApprovalCard(msg.approvalId ?? '', msg.action ?? '', payload, msg.reason ?? '');
      break;
    }
  }
});

export {};
