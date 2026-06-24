// Webview-side entry point — full UI layout (Phase 0)

import { TEMPLATE_HTML } from './template';
import { BASE_CSS } from './styles/base';
import { WARNING_CSS } from './styles/warning';
import { APPROVAL_CSS } from './styles/approval';
import {
  initOutput,
  appendOutput,
  insertUserPrompt,
  insertActivity,
  clearOutput,
  flushMarkdown,
  getMdBuffer,
  editOutcomes,
  segments,
  clearRenderTimer,
} from './output';
import {
  initProviders,
  renderProvidersList,
  renderModelDropdown,
  setProviderStatus,
  getProviderStatus,
  openProviderForm,
  closeProviderForm,
  setProviders,
  setActiveProviderIndex,
  getEditingProviderIndex,
  triggerProviderStatusCheck,
  providers,
  activeProviderIndex,
  type ProviderConfig,
} from './providers';
import {
  initApprovals,
  showApprovalCard,
  showWarningNotice,
  showQuestionCard,
  showPickCard,
  type ApprovalPayload,
} from './approvals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const acquireVsCodeApi: () => any;
const vscode = acquireVsCodeApi();

// ── DOM bootstrap ────────────────────────────────────────────────────────────

const root = document.getElementById('root')!;
root.innerHTML = TEMPLATE_HTML;

// Inline styles — keeps the webview self-contained (no external CSS file needed)
const style = document.createElement('style');
style.textContent = BASE_CSS;
document.head.appendChild(style);

const warningStyle = document.createElement('style');
warningStyle.textContent = WARNING_CSS;
document.head.appendChild(warningStyle);

const approvalStyleEl = document.createElement('style');
approvalStyleEl.textContent = APPROVAL_CSS;
document.head.appendChild(approvalStyleEl);

// ── Element refs ─────────────────────────────────────────────────────────────

const historyOverlay   = document.getElementById('history-overlay')!;
const btnHistoryClose  = document.getElementById('btn-history-close') as HTMLButtonElement;
const historyList      = document.getElementById('history-list') as HTMLUListElement;
const outputEl         = document.getElementById('output')!;
const typingIndicator  = document.getElementById('typing-indicator')!;
const promptInput  = document.getElementById('prompt-input') as HTMLTextAreaElement;
const btnSend      = document.getElementById('btn-send') as HTMLButtonElement;
const btnStop      = document.getElementById('btn-stop') as HTMLButtonElement;
const btnAttach    = document.getElementById('btn-attach') as HTMLButtonElement;
const btnAttachEditor = document.getElementById('btn-attach-editor') as HTMLButtonElement;
const settingsOverlay   = document.getElementById('settings-overlay')!;
const btnSettingsClose  = document.getElementById('btn-settings-close') as HTMLButtonElement;
const btnSettingsCancel = document.getElementById('btn-settings-cancel') as HTMLButtonElement;
const btnCopyMd    = document.getElementById('btn-copy-markdown') as HTMLButtonElement;
const btnCopyRaw   = document.getElementById('btn-copy-raw') as HTMLButtonElement;
const filesList    = document.getElementById('attached-files') as HTMLUListElement;
const statusBar    = document.getElementById('status-bar')!;
const chkThinking  = document.getElementById('chk-thinking') as HTMLInputElement;
const chkAgentsMd  = document.getElementById('chk-agents-md') as HTMLInputElement;
const lblAgentsMd  = document.getElementById('lbl-agents-md') as HTMLElement;
const modelSelect        = document.getElementById('model-select') as HTMLSelectElement;
const providerStatusDot  = document.getElementById('provider-status-dot')!;
const modelSelectorRowEl  = document.getElementById('model-selector-row')!;
const providersList      = document.getElementById('providers-list') as HTMLUListElement;
const btnAddProvider     = document.getElementById('btn-add-provider') as HTMLButtonElement;
const providerForm       = document.getElementById('provider-form')!;
const providerFormTitle  = document.getElementById('provider-form-title')!;
const pfName             = document.getElementById('pf-name') as HTMLInputElement;
const pfBaseUrl          = document.getElementById('pf-base-url') as HTMLInputElement;
const pfModel            = document.getElementById('pf-model') as HTMLInputElement;
const pfApiKey           = document.getElementById('pf-api-key') as HTMLInputElement;
const pfContext          = document.getElementById('pf-context') as HTMLInputElement;
const btnPfSave          = document.getElementById('btn-pf-save') as HTMLButtonElement;
const btnPfCancel        = document.getElementById('btn-pf-cancel') as HTMLButtonElement;
const globalMaxToolRounds = document.getElementById('global-max-tool-rounds') as HTMLInputElement;
const btnSettingsSave    = document.getElementById('btn-settings-save') as HTMLButtonElement;

// ── Module init ───────────────────────────────────────────────────────────────

initOutput(outputEl);

outputEl.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('[data-file]') as HTMLElement | null;
  if (!target) { return; }
  e.preventDefault();
  const filePath = target.dataset.file;
  if (filePath) { vscode.postMessage({ type: 'open-file', relativePath: filePath }); }
});

initProviders({
  providersList,
  modelSelect,
  providerStatusDot,
  providerForm,
  providerFormTitle,
  pfName,
  pfBaseUrl,
  pfModel,
  pfApiKey,
  pfContext,
  vscode,
});

// Container for approval cards — inserted before the model selector row
const appEl = document.getElementById('app')!;
const approvalsContainer = document.createElement('div');
approvalsContainer.id = 'approvals-container';
// Keep approvals above the model selector, which lives at the bottom near the composer.
const inputRowEl = document.getElementById('input-row')!;
appEl.insertBefore(approvalsContainer, modelSelectorRowEl ?? inputRowEl);

initApprovals(approvalsContainer, vscode);

// ── State ────────────────────────────────────────────────────────────────────

interface AttachedFile { uri: string; relativePath: string; }

let attachedFiles: AttachedFile[] = [];
let isGenerating = false;

/** Tracks whether the current generation was explicitly cancelled by the user. */
let wasExplicitlyCancelled = false;
/** Tracks whether there is an active editor in VS Code. */
let hasActiveEditor = false;

// Ensure initial composer button state is correct
setGenerating(false);

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  statusBar.textContent = text;
}

function setStatusBadge(badgeClass: string, badgeText: string, detail?: string): void {
  statusBar.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `status-badge ${badgeClass}`;
  badge.textContent = badgeText;
  statusBar.appendChild(badge);
  if (detail) {
    statusBar.appendChild(document.createTextNode(' ' + detail));
  }
}

function updateComposerButtons(): void {
  if (isGenerating) {
    const hasText = promptInput.value.trim().length > 0;
    btnSend.hidden = !hasText;
    btnStop.hidden = hasText;
    btnSend.disabled = false;
    btnStop.disabled = false;
  } else {
    btnSend.hidden = false;
    btnStop.hidden = true;
    btnSend.disabled = false;
    btnStop.disabled = true;
  }
}

function setGenerating(active: boolean): void {
  isGenerating = active;
  updateComposerButtons();
  // Reset cancelled state when starting new generation
  if (active) {
    wasExplicitlyCancelled = false;
    outputEl.classList.remove('cancelled');
    typingIndicator.hidden = false;
  } else {
    typingIndicator.hidden = true;
  }
}

function setEditorState(hasEditor: boolean): void {
  hasActiveEditor = hasEditor;
  btnAttachEditor.disabled = !hasEditor;
}

function renderAttachedFiles(): void {
  filesList.innerHTML = '';

  // AGENTS.md pill — shown when the checkbox is checked
  if (chkAgentsMd.checked) {
    const li = document.createElement('li');
    li.id = 'pill-agents-md';
    const label = document.createTextNode('AGENTS.md');
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      chkAgentsMd.checked = false;
      renderAttachedFiles();
    });
    li.appendChild(label);
    li.appendChild(removeBtn);
    filesList.appendChild(li);
  }

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

// ── Settings panel ────────────────────────────────────────────────────────────

/** Last focused element before settings opened — restored on close. */
let _settingsReturnFocus: HTMLElement | null = null;

function getSettingsFocusable(): HTMLElement[] {
  const panel = document.getElementById('settings-panel')!;
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.closest('[hidden]'));
}

function openSettingsPanel(): void {
  _settingsReturnFocus = document.activeElement as HTMLElement | null;
  settingsOverlay.hidden = false;
  requestAnimationFrame(() => {
    const first = getSettingsFocusable()[0];
    if (first) first.focus();
  });
}

function closeSettings(): void {
  settingsOverlay.hidden = true;
  _settingsReturnFocus?.focus();
  _settingsReturnFocus = null;
}

// ── History panel ─────────────────────────────────────────────────────────────

interface SessionSummary { sessionId: string; title: string; createdAt: number; updatedAt?: number; messageCount: number; }

function formatDuration(startMs: number, endMs: number): string {
  const mins = Math.round((endMs - startMs) / 60000);
  if (mins < 1) { return '<1 min'; }
  if (mins < 60) { return `${mins} min`; }
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs} hr` : `${hrs} hr ${rem} min`;
}

let _historySessions: SessionSummary[] = [];

function openHistoryPanel(): void {
  historyOverlay.hidden = false;
  renderHistoryList();
  requestAnimationFrame(() => btnHistoryClose.focus());
}

function closeHistoryPanel(): void {
  historyOverlay.hidden = true;
}

function renderHistoryList(): void {
  historyList.innerHTML = '';
  if (_historySessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No sessions yet.';
    historyList.appendChild(empty);
    return;
  }
  let lastDateLabel = '';
  for (const s of _historySessions) {
    const d = new Date(s.createdAt);
    const dateLabel = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (dateLabel !== lastDateLabel) {
      lastDateLabel = dateLabel;
      const sep = document.createElement('li');
      sep.className = 'history-date-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = dateLabel;
      historyList.appendChild(sep);
    }
    const li = document.createElement('li');
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    const prompt = document.createElement('div');
    prompt.className = 'history-item-title';
    const raw = s.title.replace(/\s+/g, ' ').trim();
    prompt.textContent = raw.length > 72 ? raw.slice(0, 69) + '…' : raw;
    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span');
    timeSpan.textContent = timeStr;
    meta.appendChild(timeSpan);
    if (s.updatedAt && s.updatedAt > s.createdAt) {
      const sep = document.createElement('span');
      sep.className = 'history-item-meta-sep';
      sep.textContent = '·';
      const dur = document.createElement('span');
      dur.className = 'history-item-duration';
      dur.textContent = formatDuration(s.createdAt, s.updatedAt);
      meta.appendChild(sep);
      meta.appendChild(dur);
    }
    li.appendChild(prompt);
    li.appendChild(meta);
    const restore = () => {
      closeHistoryPanel();
      vscode.postMessage({ type: 'restoreSession', sessionId: s.sessionId });
    };
    li.addEventListener('click', restore);
    li.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restore(); }
    });
    historyList.appendChild(li);
  }
}

btnHistoryClose.addEventListener('click', closeHistoryPanel);

historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) { closeHistoryPanel(); }
});

historyOverlay.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') { e.preventDefault(); closeHistoryPanel(); }
});

// ── Event handlers ───────────────────────────────────────────────────────────

btnSend.addEventListener('click', sendPrompt);

// Auto-resize textarea as the user types
function autoResizeTextarea(): void {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 220) + 'px';
}
promptInput.addEventListener('input', () => {
  autoResizeTextarea();
  if (isGenerating) { updateComposerButtons(); }
});

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

btnSettingsClose.addEventListener('click', closeSettings);
btnSettingsCancel.addEventListener('click', closeSettings);

btnSettingsSave.addEventListener('click', () => {
  const rounds = parseInt(globalMaxToolRounds.value, 10);
  vscode.postMessage({ type: 'saveSettings', maxToolRounds: isNaN(rounds) ? undefined : rounds });
  closeSettings();
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) { closeSettings(); }
});

settingsOverlay.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return;
  }
  if (e.key === 'Tab') {
    const focusable = getSettingsFocusable();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
});

// Sync checkbox state changes to the extension immediately
chkAgentsMd.addEventListener('change', () => {
  vscode.postMessage({ type: 'checkboxChange', includeAgentsMd: chkAgentsMd.checked });
});

// Provider form handlers
btnAddProvider.addEventListener('click', () => openProviderForm(-1));

btnPfCancel.addEventListener('click', closeProviderForm);

btnPfSave.addEventListener('click', () => {
  const p: ProviderConfig = {
    name: pfName.value.trim() || pfModel.value.trim() || 'unnamed',
    baseUrl: pfBaseUrl.value.trim(),
    model: pfModel.value.trim(),
    apiKey: pfApiKey.value || undefined,
    context: parseInt(pfContext.value, 10) || 32768,
  };
  const editingIdx = getEditingProviderIndex();
  if (editingIdx === -1) {
    providers.push(p);
  } else {
    providers[editingIdx] = p;
  }
  vscode.postMessage({ type: 'saveSettings', providers });
  renderProvidersList();
  renderModelDropdown();
  closeProviderForm();
  triggerProviderStatusCheck();
});

// Model dropdown selection
modelSelect.addEventListener('change', () => {
  const idx = parseInt(modelSelect.value, 10);
  if (!isNaN(idx)) {
    setActiveProviderIndex(idx);
    setProviderStatus('checking');
    vscode.postMessage({ type: 'selectModel', providerIndex: idx });
  }
});

// Re-check provider health when dropdown closes while status is offline
modelSelect.addEventListener('blur', () => {
  if (getProviderStatus() === 'offline') {
    triggerProviderStatusCheck();
  }
});

// ── Copy actions ──────────────────────────────────────────────────────────────

/**
 * Copy the rendered markdown (HTML) to clipboard as plain text.
 * This gives the user the markdown source that was rendered.
 */
btnCopyMd.addEventListener('click', async () => {
  const mdContent = getMdBuffer();
  if (!mdContent) {
    setStatus('Nothing to copy.');
    return;
  }
  try {
    await navigator.clipboard.writeText(mdContent);
    setStatus('Markdown copied to clipboard.');
    btnCopyMd.classList.add('flash-success');
    setTimeout(() => btnCopyMd.classList.remove('flash-success'), 500);
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
    btnCopyRaw.classList.add('flash-success');
    setTimeout(() => btnCopyRaw.classList.remove('flash-success'), 500);
  } catch {
    setStatus('Failed to copy raw text.');
  }
});

let pendingSend: { prompt: string; thinkingMode: boolean; includeAgentsMd: boolean } | null = null;

function sendPrompt(): void {
  const prompt = promptInput.value.trim();
  if (!prompt) { return; }

  // Steer: user is sending while AI is still generating
  if (isGenerating) {
    // The old generation is about to be aborted; clear any pending cards tied to it.
    approvalsContainer.innerHTML = '';
    // Flush any buffered partial response before inserting user prompt
    clearRenderTimer();
    if (segments.length > 0) { flushMarkdown(); }
    insertUserPrompt(prompt);
    vscode.postMessage({ type: 'steer', prompt, thinkingMode: chkThinking.checked, includeAgentsMd: chkAgentsMd.checked });
    promptInput.value = '';
    promptInput.style.height = '';
    updateComposerButtons();
    return;
  }

  if (getProviderStatus() === 'offline') {
    // Re-check before giving up — store the pending send and trigger a health check
    pendingSend = { prompt, thinkingMode: chkThinking.checked, includeAgentsMd: chkAgentsMd.checked };
    setProviderStatus('checking');
    vscode.postMessage({ type: 'selectModel', providerIndex: activeProviderIndex });
    return;
  }

  setStatus('');
  setGenerating(true);
  insertUserPrompt(prompt);
  vscode.postMessage({ type: 'send', prompt, thinkingMode: chkThinking.checked, includeAgentsMd: chkAgentsMd.checked });
  promptInput.value = '';
  promptInput.style.height = '';
}

// ── Message handler (extension → webview) ────────────────────────────────────

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
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
    questionId?: string;
    question?: string;
    pickId?: string;
    prompt?: string;
    options?: string[];
    usage?: TokenUsage;
    contextTokens?: number;
    cancelled?: boolean;
    finishReason?: string;
    hasActiveEditor?: boolean;
    uri?: string;
    outcome?: 'applied' | 'cancelled';
    available?: boolean;
    thinkingMode?: boolean;
    includeAgentsMd?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    providers?: ProviderConfig[];
    activeProviderIndex?: number;
    label?: string;
    detail?: string;
    providerName?: string;
    maxToolRounds?: number;
    status?: 'online' | 'offline' | 'checking';
  };

  switch (msg.type) {
    case 'userPrompt':
      typingIndicator.hidden = true;
      insertUserPrompt(msg.content ?? '');
      break;

    case 'delta':
      typingIndicator.hidden = true;
      appendOutput(msg.content ?? '');
      break;

    case 'done':
      // Flush any remaining buffered markdown before marking done
      clearRenderTimer();
      if (segments.length > 0) { flushMarkdown(); }
      setGenerating(false);
      // Dismiss any approval cards left over from a cancelled run
      if (msg.cancelled) {
        approvalsContainer.innerHTML = '';
        setStatusBadge('cancelled', 'Cancelled');
      } else {
        const fr = msg.finishReason;
        const frSuffix = fr ? ` · ${fr}` : '';
        const u = msg.usage;
        if (u && u.totalTokens > 0) {
          const cached = u.cachedInputTokens ?? 0;
          const cacheSuffix = cached > 0 ? `, ${cached.toLocaleString()} cached` : '';
          setStatusBadge('completed', 'Done', `${u.totalTokens.toLocaleString()} tokens (${u.promptTokens.toLocaleString()} + ${u.completionTokens.toLocaleString()}${cacheSuffix})${frSuffix}`);
        } else if (msg.contextTokens) {
          setStatusBadge('completed', 'Done', `~${msg.contextTokens.toLocaleString()} ctx tokens${frSuffix}`);
        } else {
          setStatusBadge('completed', 'Done', fr || undefined);
        }
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

    case 'tool-activity':
      insertActivity(msg.label ?? msg.text ?? '', msg.detail, msg.filePath);
      break;

    case 'attachments':
      if (msg.files) {
        attachedFiles = msg.files.map(f => ({ uri: f.uri, relativePath: f.relativePath }));
        renderAttachedFiles();
      }
      break;

    case 'approval/request': {
      const payload = msg.payload as ApprovalPayload | undefined;
      showApprovalCard(msg.approvalId ?? '', msg.action ?? '', payload, msg.reason ?? '', msg.allowKey);
      break;
    }

    case 'question/request': {
      showQuestionCard(msg.questionId ?? '', msg.question ?? '');
      break;
    }

    case 'pick/request': {
      showPickCard(msg.pickId ?? '', msg.prompt ?? '', msg.options ?? []);
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

    case 'agentsMdAvailable': {
      lblAgentsMd.hidden = !msg.available;
      if (!msg.available) {
        chkAgentsMd.checked = false;
      }
      break;
    }

    case 'checkboxState': {
      chkThinking.checked = msg.thinkingMode ?? true;
      chkAgentsMd.checked = msg.includeAgentsMd ?? false;
      break;
    }

    case 'newSession': {
      setGenerating(false);
      clearOutput();
      approvalsContainer.innerHTML = '';
      attachedFiles = [];
      chkAgentsMd.checked = false;
      chkThinking.checked = false;
      renderAttachedFiles();
      break;
    }

    case 'openSettings': {
      if (msg.providers) {
        setProviders(msg.providers, msg.activeProviderIndex ?? 0);
        renderProvidersList();
        renderModelDropdown();
      }
      globalMaxToolRounds.value = String(msg.maxToolRounds ?? 40);
      openSettingsPanel();
      break;
    }

    case 'providers': {
      if (msg.providers) {
        setProviders(msg.providers, msg.activeProviderIndex ?? 0);
        renderModelDropdown();
        // Check health of active provider on load
        if (providers.length > 0) {
          setProviderStatus('checking');
          vscode.postMessage({ type: 'selectModel', providerIndex: activeProviderIndex });
        }
      }
      break;
    }

    case 'providerStatus': {
      if (msg.status) {
        setProviderStatus(msg.status);
        if (pendingSend && msg.status !== 'checking') {
          const ps = pendingSend;
          pendingSend = null;
          if (msg.status === 'online') {
            setStatus('');
            setGenerating(true);
            insertUserPrompt(ps.prompt);
            vscode.postMessage({ type: 'send', prompt: ps.prompt, thinkingMode: ps.thinkingMode, includeAgentsMd: ps.includeAgentsMd });
            promptInput.value = '';
            promptInput.style.height = '';
          } else if (msg.status === 'offline') {
            setStatus('Model is offline — request not sent.');
          }
        }
      }
      break;
    }

    case 'sessions': {
      _historySessions = (msg as unknown as { sessions: SessionSummary[] }).sessions ?? [];
      openHistoryPanel();
      break;
    }
  }
});

// Suppress unused variable warnings for state vars only read in closures
void wasExplicitlyCancelled;
void hasActiveEditor;

export {};
