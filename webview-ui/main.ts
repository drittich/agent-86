// Webview-side entry point — full UI layout (Phase 0)

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const acquireVsCodeApi: () => any;
const vscode = acquireVsCodeApi();

// ── DOM bootstrap ────────────────────────────────────────────────────────────

const root = document.getElementById('root')!;
root.innerHTML = `
<div id="app">
  <div id="toolbar">
    <button id="btn-new-session" title="New session">New Session</button>
    <button id="btn-select-session" title="Select session">Select Session</button>
    <button id="btn-attach" title="Attach files">Attach Files</button>
    <button id="btn-attach-editor" title="Attach active editor or selection">Attach Editor</button>
  </div>

  <ul id="attached-files"></ul>

  <div id="output-wrapper">
    <div id="output-toolbar">
      <button id="btn-copy-markdown" title="Copy rendered markdown">Copy Markdown</button>
      <button id="btn-copy-raw" title="Copy raw text">Copy Raw</button>
    </div>
    <div id="output" aria-live="polite"></div>
  </div>

  <div id="status-bar"></div>

  <div id="input-row">
    <textarea id="prompt-input" rows="4" placeholder="Ask the agent…"></textarea>
    <div id="thinking-row">
      <label><input type="checkbox" id="chk-thinking"> Thinking mode</label>
    </div>
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

  html, body {
    height: 100%;
    overflow: hidden;
  }

  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, #1e1e1e);
    display: flex;
    flex-direction: column;
  }

  #root {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  #app {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
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

  #output-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  #output-toolbar {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
    flex-shrink: 0;
  }

  #output-toolbar button {
    font-size: 11px;
    padding: 2px 8px;
  }

  #output {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--vscode-widget-border, #444);
    padding: 8px;
    word-break: break-word;
    line-height: 1.5;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    border-radius: 2px;
    min-height: 60px;
  }

  /* Markdown prose styles */
  #output p { margin: 0 0 0.6em; }
  #output p:last-child { margin-bottom: 0; }
  #output h1, #output h2, #output h3,
  #output h4, #output h5, #output h6 {
    margin: 0.8em 0 0.3em;
    line-height: 1.3;
  }
  #output h1 { font-size: 1.4em; }
  #output h2 { font-size: 1.2em; }
  #output h3 { font-size: 1.05em; }
  #output ul, #output ol {
    margin: 0 0 0.6em 1.4em;
    padding: 0;
  }
  #output li { margin-bottom: 0.2em; }
  #output code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }
  #output pre {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    padding: 8px;
    overflow-x: auto;
    margin: 0 0 0.6em;
  }
  #output pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.88em;
    white-space: pre;
  }
  #output blockquote {
    border-left: 3px solid var(--vscode-widget-border, #555);
    margin: 0 0 0.6em 0;
    padding: 0 0 0 10px;
    color: var(--vscode-descriptionForeground);
  }
  #output hr {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, #444);
    margin: 0.8em 0;
  }
  #output a {
    color: var(--vscode-textLink-foreground, #4e9fde);
  }

  /* Edit accordion */
  #output details.edit-accordion {
    margin: 0 0 0.6em;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  }
  #output details.edit-accordion summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
    user-select: none;
    list-style: none;
  }
  #output details.edit-accordion summary::before {
    content: '▶ ';
    font-size: 0.75em;
  }
  #output details.edit-accordion[open] summary::before {
    content: '▼ ';
  }
  #output details.edit-accordion pre {
    margin: 0;
    border: none;
    border-top: 1px solid var(--vscode-panel-border, #444);
    border-radius: 0 0 3px 3px;
  }
  #output table {
    border-collapse: collapse;
    margin: 0 0 0.6em;
    font-size: 0.9em;
  }
  #output th, #output td {
    border: 1px solid var(--vscode-panel-border, #444);
    padding: 3px 8px;
  }
  #output th { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); }

  #status-bar {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-height: 16px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .status-badge.completed {
    background: var(--vscode-testing-passedBackground, #1e3a1e);
    color: var(--vscode-testing-passedForeground, #4ec94e);
  }

  .status-badge.cancelled {
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-inputValidation-warningForeground, #cca700);
  }

  /* Dimmed output content when cancelled */
  #output.cancelled {
    opacity: 0.7;
    border-color: var(--vscode-inputValidation-warningBorder, #b89500);
  }

  #approvals-container {
    flex-shrink: 0;
  }

  #input-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
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

  #thinking-row {
    padding: 4px 0 2px 0;
    font-size: 0.85em;
    color: var(--vscode-foreground);
  }
  #thinking-row input { margin-right: 4px; }
`;
document.head.appendChild(style);

// ── Element refs ─────────────────────────────────────────────────────────────

const outputEl     = document.getElementById('output')!;
const promptInput  = document.getElementById('prompt-input') as HTMLTextAreaElement;
const btnSend      = document.getElementById('btn-send') as HTMLButtonElement;
const btnStop      = document.getElementById('btn-stop') as HTMLButtonElement;
const btnAttach    = document.getElementById('btn-attach') as HTMLButtonElement;
  const btnAttachEditor = document.getElementById('btn-attach-editor') as HTMLButtonElement;
  const btnNewSess   = document.getElementById('btn-new-session') as HTMLButtonElement;
const btnSelectSess = document.getElementById('btn-select-session') as HTMLButtonElement;
const btnCopyMd    = document.getElementById('btn-copy-markdown') as HTMLButtonElement;
const btnCopyRaw   = document.getElementById('btn-copy-raw') as HTMLButtonElement;
const filesList    = document.getElementById('attached-files') as HTMLUListElement;
const statusBar    = document.getElementById('status-bar')!;
const chkThinking  = document.getElementById('chk-thinking') as HTMLInputElement;

// ── State ────────────────────────────────────────────────────────────────────

interface AttachedFile { uri: string; relativePath: string; }

let attachedFiles: AttachedFile[] = [];
let isGenerating = false;
/** Tracks whether the current generation was explicitly cancelled by the user. */
let wasExplicitlyCancelled = false;
/** Tracks whether there is an active editor in VS Code. */
let hasActiveEditor = false;

/** Tracks edit outcomes by URI so accordions can show "Edited" vs "Editing". */
const editOutcomes = new Map<string, 'applied' | 'cancelled'>();

// Markdown rendering — buffer incoming deltas and flush on a timer
let markdownBuffer = '';
let renderTimer: ReturnType<typeof setTimeout> | null = null;
const RENDER_INTERVAL_MS = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  statusBar.textContent = text;
}

/**
 * Replace JSON edit blocks (bare or ```json fenced) with collapsed <details>
 * accordions showing the files being edited. Called before markdown rendering.
 */
function replaceEditJsonWithAccordions(md: string): string {
  // Match either a ```json ... ``` fence or a bare { ... } block containing "edits"
  // We'll process the string, finding JSON candidates that have an "edits" array.
  const result: string[] = [];
  let lastIndex = 0;

  // Regex: matches ```json\n{...}\n``` (fenced) — non-greedy, allows multiline
  const fencedRe = /```json\s*(\{[\s\S]*?"edits"[\s\S]*?\})\s*```/g;
  let fencedMatch: RegExpExecArray | null;
  const fencedMatches: Array<{ index: number; end: number; json: string }> = [];
  while ((fencedMatch = fencedRe.exec(md)) !== null) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      if (parsed && Array.isArray(parsed.edits)) {
        fencedMatches.push({ index: fencedMatch.index, end: fencedMatch.index + fencedMatch[0].length, json: fencedMatch[1] });
      }
    } catch { /* not valid JSON */ }
  }

  // Also find bare JSON objects with "edits" not inside a fence
  // Build a list of fenced ranges to exclude
  const fencedRanges = fencedMatches.map(m => [m.index, m.end]);

  function isInFencedRange(idx: number): boolean {
    return fencedRanges.some(([s, e]) => idx >= s && idx < e);
  }

  // Extract bare JSON candidates (top-level { }) not inside fences
  const bareMatches: Array<{ index: number; end: number; json: string }> = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < md.length; i++) {
    const ch = md[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        if (!isInFencedRange(start)) {
          const candidate = md.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && Array.isArray(parsed.edits)) {
              bareMatches.push({ index: start, end: i + 1, json: candidate });
            }
          } catch { /* not valid JSON */ }
        }
        start = -1;
      }
    }
  }

  // Merge and sort all matches by index
  const allMatches = [...fencedMatches, ...bareMatches].sort((a, b) => a.index - b.index);

  for (const match of allMatches) {
    result.push(md.slice(lastIndex, match.index));
    result.push(buildEditAccordionHtml(match.json));
    lastIndex = match.end;
  }
  result.push(md.slice(lastIndex));
  return result.join('');
}

function buildEditAccordionHtml(json: string): string {
  let files: string[] = [];
  try {
    const parsed = JSON.parse(json);
    if (parsed && Array.isArray(parsed.edits)) {
      const uris: string[] = parsed.edits.map((e: { uri?: string }) => e.uri).filter(Boolean);
      files = [...new Set(uris)];
    }
  } catch { /* ignore */ }

  let title: string;
  if (files.length === 0) {
    title = 'Edit block';
  } else {
    // Use outcome of first file to determine verb; fall back to "Editing" while pending
    const outcome = editOutcomes.get(files[0]);
    const verb = outcome === 'applied' ? 'Edited' : outcome === 'cancelled' ? 'Edit cancelled:' : 'Editing';
    title = `${verb} ${files.join(', ')}`;
  }

  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `\n<details class="edit-accordion"><summary>${title}</summary><pre><code>${escaped}</code></pre></details>\n`;
}

function flushMarkdown(): void {
  const wasAtBottom =
    outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 8;
  const processedMd = replaceEditJsonWithAccordions(markdownBuffer);
  outputEl.innerHTML = DOMPurify.sanitize(marked.parse(processedMd) as string);
  if (wasAtBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

function appendOutput(text: string): void {
  markdownBuffer += text;
  if (renderTimer === null) {
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushMarkdown();
    }, RENDER_INTERVAL_MS);
  }
}

function clearOutput(): void {
  markdownBuffer = '';
  editOutcomes.clear();
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  outputEl.innerHTML = '';
}

function setGenerating(active: boolean): void {
  isGenerating = active;
  btnSend.disabled = active;
  btnStop.disabled = !active;
  promptInput.disabled = active;
  // Reset cancelled state when starting new generation
  if (active) {
    wasExplicitlyCancelled = false;
    outputEl.classList.remove('cancelled');
  }
}

function setEditorState(hasEditor: boolean): void {
  hasActiveEditor = hasEditor;
  btnAttachEditor.disabled = !hasEditor;
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
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    sendPrompt();
  }
});

btnStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
  // UI update is deferred until the extension replies with done(cancelled:true)
});

btnAttach.addEventListener('click', () => {
  vscode.postMessage({ type: 'attachFiles' });
});

btnAttachEditor.addEventListener('click', () => {
  vscode.postMessage({ type: 'attachActiveEditor' });
});

btnNewSess.addEventListener('click', () => {
  clearOutput();
  attachedFiles = [];
  renderAttachedFiles();
  setStatus('');
  vscode.postMessage({ type: 'newSession' });
});

btnSelectSess.addEventListener('click', () => {
  vscode.postMessage({ type: 'selectSession' });
});

// ── Copy actions ──────────────────────────────────────────────────────────────

/**
 * Copy the rendered markdown (HTML) to clipboard as plain text.
 * This gives the user the markdown source that was rendered.
 */
btnCopyMd.addEventListener('click', async () => {
  if (!markdownBuffer) {
    setStatus('Nothing to copy.');
    return;
  }
  try {
    await navigator.clipboard.writeText(markdownBuffer);
    setStatus('Markdown copied to clipboard.');
  } catch {
    setStatus('Failed to copy markdown.');
  }
});

/**
 * Copy the raw text content from the output element.
 * This strips all formatting and gives plain text.
 */
btnCopyRaw.addEventListener('click', async () => {
  const rawText = outputEl.textContent ?? '';
  if (!rawText.trim()) {
    setStatus('Nothing to copy.');
    return;
  }
  try {
    await navigator.clipboard.writeText(rawText);
    setStatus('Raw text copied to clipboard.');
  } catch {
    setStatus('Failed to copy raw text.');
  }
});

function sendPrompt(): void {
  const prompt = promptInput.value.trim();
  if (!prompt || isGenerating) { return; }
  clearOutput();
  setStatus('');
  setGenerating(true);
  appendOutput('**You:** ' + prompt + '\n\n---\n\n');
  vscode.postMessage({ type: 'send', prompt, thinkingMode: chkThinking.checked });
  promptInput.value = '';
}

// ── Warning notice ────────────────────────────────────────────────────────────

const warningStyle = document.createElement('style');
warningStyle.textContent = `
  .warning-notice {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-inputValidation-warningForeground, #cca700);
    border-radius: 3px;
    padding: 6px 10px;
    margin: 6px 0;
    font-size: 12px;
  }
  .warning-notice .warning-icon {
    flex-shrink: 0;
    font-style: normal;
  }
  .warning-notice .warning-text {
    flex: 1;
    word-break: break-word;
  }
  .warning-notice .warning-dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    padding: 0 2px;
    font-size: 14px;
    line-height: 1;
  }
  .warning-notice .warning-dismiss:hover { opacity: 1; }
`;
document.head.appendChild(warningStyle);

function showWarningNotice(text: string): void {
  const notice = document.createElement('div');
  notice.className = 'warning-notice';

  const icon = document.createElement('span');
  icon.className = 'warning-icon';
  icon.textContent = '⚠';

  const textEl = document.createElement('span');
  textEl.className = 'warning-text';
  textEl.textContent = text;

  const dismiss = document.createElement('button');
  dismiss.className = 'warning-dismiss';
  dismiss.title = 'Dismiss';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => notice.remove());

  notice.appendChild(icon);
  notice.appendChild(textEl);
  notice.appendChild(dismiss);
  approvalsContainer.appendChild(notice);
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
    case 'applyEdit':  return 'Apply edit?';
    default:           return `Approve: ${action}?`;
  }
}

function getApproveLabel(action: string): string {
  switch (action) {
    case 'runCommand': return 'Run';
    case 'deleteFile': return 'Delete';
    case 'applyEdit':  return 'Apply';
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

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

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
    usage?: TokenUsage;
    cancelled?: boolean;
    hasActiveEditor?: boolean;
    uri?: string;
    outcome?: 'applied' | 'cancelled';
  };

  switch (msg.type) {
    case 'delta':
      appendOutput(msg.content ?? '');
      break;

    case 'done':
      // Flush any remaining buffered markdown before marking done
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      if (markdownBuffer) { flushMarkdown(); }
      setGenerating(false);
      // Dismiss any approval cards left over from a cancelled run
      if (msg.cancelled) {
        approvalsContainer.innerHTML = '';
        setStatus('Cancelled.');
      } else if (msg.usage) {
        const u = msg.usage;
        setStatus(`Done. \u2022 ${u.totalTokens.toLocaleString()} tokens (${u.promptTokens.toLocaleString()} prompt + ${u.completionTokens.toLocaleString()} completion)`);
      } else {
        setStatus('Done.');
      }
      break;

    case 'warning':
      showWarningNotice(msg.text ?? 'Unknown warning');
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

    case 'editorState': {
      setEditorState(msg.hasActiveEditor ?? false);
      break;
    }

    case 'editResult': {
      if (msg.uri && msg.outcome) {
        editOutcomes.set(msg.uri, msg.outcome);
        flushMarkdown();
      }
      break;
    }
  }
});

export {};
