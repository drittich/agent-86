/**
 * Approval card, warning notice, and question card logic.
 * Handles user-facing approval gates for tool execution.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApprovalPayload = {
  path?: string;
  command?: string;
  from?: string;
  to?: string;
};

// ── Module state ──────────────────────────────────────────────────────────────

let approvalsContainer: HTMLElement;
let vscodeApi: { postMessage(msg: unknown): void };

// Actions auto-approved for this session (populated by "Approve & Don't ask again")
const sessionAutoApproved = new Set<string>();

// Actions that are non-destructive enough to offer "Don't ask again this session"
const NON_DESTRUCTIVE_ACTIONS = new Set(['moveFile', 'applyEdit']);

// Actions that support persistent "Always allow in project" — tracked separately per category
// createFile, overwriteFile, deleteFile each get their own persistent toggle
const PROJECT_ALLOWABLE_ACTIONS = new Set(['createFile', 'overwriteFile', 'applyEdit', 'deleteFile']);

// ── Init ──────────────────────────────────────────────────────────────────────

export function initApprovals(container: HTMLElement, vscode: { postMessage(msg: unknown): void }): void {
  approvalsContainer = container;
  vscodeApi = vscode;
}

// ── Private helpers ───────────────────────────────────────────────────────────

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
  } else if (action === 'createFile') {
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'New file';
    const val = document.createElement('div');
    val.textContent = payload?.path ?? '';
    preview.appendChild(label);
    preview.appendChild(val);
  } else if (action === 'overwriteFile') {
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'File';
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
    case 'runCommand':    return 'Run terminal command?';
    case 'moveFile':      return 'Move file?';
    case 'deleteFile':    return 'Delete file?';
    case 'applyEdit':     return 'Apply edit?';
    case 'createFile':    return 'Create file?';
    case 'overwriteFile': return 'Overwrite file?';
    default:              return `Approve: ${action}?`;
  }
}

function getApproveLabel(action: string): string {
  switch (action) {
    case 'runCommand':    return 'Run';
    case 'deleteFile':    return 'Delete';
    case 'applyEdit':     return 'Apply';
    case 'createFile':    return 'Create';
    case 'overwriteFile': return 'Overwrite';
    default:              return 'Approve';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function showApprovalCard(
  approvalId: string,
  action: string,
  payload: ApprovalPayload | undefined,
  reason: string
): void {
  // If this action was auto-approved for the session, respond immediately
  if (sessionAutoApproved.has(action)) {
    vscodeApi.postMessage({ type: 'approval/response', approvalId, approved: true });
    return;
  }

  const card = document.createElement('div');
  const riskClass = (action === 'deleteFile' || action === 'runCommand') ? 'risk-danger'
    : (action === 'moveFile' || action === 'overwriteFile') ? 'risk-warn'
    : '';
  card.className = riskClass ? `approval-card ${riskClass}` : 'approval-card';
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
    vscodeApi.postMessage({ type: 'approval/response', approvalId, approved: true });
    card.remove();
  });

  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn-deny';
  denyBtn.textContent = 'Deny';
  // Default focus: Deny (safer default)
  denyBtn.autofocus = true;
  denyBtn.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'approval/response', approvalId, approved: false });
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
      vscodeApi.postMessage({ type: 'approval/response', approvalId, approved: true });
      card.remove();
    });
    buttons.appendChild(alwaysBtn);
  }

  // "Always allow in project" — persistent per action category (create / edit / delete)
  if (PROJECT_ALLOWABLE_ACTIONS.has(action)) {
    const projectBtn = document.createElement('button');
    projectBtn.className = 'btn-approve-always';
    projectBtn.textContent = 'Always allow in project';
    projectBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'approval/alwaysAllow', action });
      vscodeApi.postMessage({ type: 'approval/response', approvalId, approved: true });
      card.remove();
    });
    buttons.appendChild(projectBtn);
  }

  card.appendChild(buttons);
  approvalsContainer.appendChild(card);

  // Focus the deny button so keyboard users default to the safe choice
  denyBtn.focus();
}

export function showWarningNotice(text: string): void {
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

export function showQuestionCard(questionId: string, question: string): void {
  const card = document.createElement('div');
  card.className = 'question-card';
  card.dataset.questionId = questionId;

  const questionEl = document.createElement('div');
  questionEl.className = 'question-text';
  questionEl.textContent = question;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'question-input';
  input.placeholder = 'Type your answer…';

  const hint = document.createElement('div');
  hint.className = 'question-hint';
  hint.textContent = 'Press Enter to submit';

  const submit = (): void => {
    const answer = input.value.trim();
    if (!answer) { return; }
    vscodeApi.postMessage({ type: 'question/response', questionId, answer });
    card.remove();
  };

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  card.appendChild(questionEl);
  card.appendChild(input);
  card.appendChild(hint);
  approvalsContainer.appendChild(card);
  input.focus();
}

export function showPickCard(pickId: string, prompt: string, options: string[]): void {
  const card = document.createElement('div');
  card.className = 'question-card';
  card.dataset.pickId = pickId;

  const promptEl = document.createElement('div');
  promptEl.className = 'question-text';
  promptEl.textContent = prompt;

  const list = document.createElement('ol');
  list.className = 'pick-list';
  for (const opt of options) {
    const li = document.createElement('li');
    li.textContent = opt;
    list.appendChild(li);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'question-input';
  input.placeholder = `1–${options.length}, comma-separated, or Enter to skip`;

  const hint = document.createElement('div');
  hint.className = 'question-hint';
  hint.textContent = 'Enter numbers to select, or press Enter to skip';

  const submit = (): void => {
    const raw = input.value.trim();
    let indices: number[] = [];
    if (raw) {
      indices = raw
        .split(/[\s,]+/)
        .map(s => parseInt(s, 10) - 1)          // convert 1-based to 0-based
        .filter(n => !isNaN(n) && n >= 0 && n < options.length);
    }
    vscodeApi.postMessage({ type: 'pick/response', pickId, indices });
    card.remove();
  };

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  card.appendChild(promptEl);
  card.appendChild(list);
  card.appendChild(input);
  card.appendChild(hint);
  approvalsContainer.appendChild(card);
  input.focus();
}
