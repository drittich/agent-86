import { ChatMessage } from '../providers/IProvider';

/**
 * Harness-driven plan execution state.
 *
 * The model proposes a plan once via the `set_plan` tool; from that point the
 * harness owns the loop: each step runs in a fresh, focused context
 * (pre-turn history + original task + plan status + handoff notes + step
 * directive), and the harness — not the model — decides when a step is done
 * and advances to the next one. This keeps context small and steps focused,
 * which matters for small local models.
 */

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
  /** One-line outcome shown in the final summary. */
  outcome?: string;
}

export interface PlanRunState {
  items: PlanItem[];
  currentIndex: number;
  /** Mechanical handoff notes, one per finished step. */
  handoffNotes: string[];
  /** History index where the current step's transcript begins. */
  itemStartIndex: number;
  /** Tool rounds consumed by the current step. */
  itemToolRounds: number;
  /** True once the current step was nudged to wrap up (tool budget hit). */
  itemBudgetNudged: boolean;
  /** True once the current step has used its single verification retry. */
  itemRetried: boolean;
  /** Snapshot of history before this turn's user message (prior conversation). */
  preTurnHistory: ChatMessage[];
  /** The user message that started this turn (task + injected attachments). */
  anchorMessage: ChatMessage;
}

const MAX_PLAN_ITEMS = 12;
const MAX_ITEM_CHARS = 300;

/**
 * Parse the `set_plan` tool arguments into a list of step strings.
 * Accepts `items` (preferred) or `steps`; tolerates a single newline-separated
 * string with optional "1." / "-" prefixes (small models do this).
 * Returns null when no usable steps are found.
 */
export function parsePlanItems(args: Record<string, unknown>): string[] | null {
  let raw = args['items'] ?? args['steps'];
  if (typeof raw === 'string') {
    raw = raw.split(/\r?\n/);
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const items = raw
    .map(item => String(typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['title'] ?? '' : item ?? ''))
    .map(s => s.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter(s => s.length > 0)
    .map(s => s.slice(0, MAX_ITEM_CHARS))
    .slice(0, MAX_PLAN_ITEMS);
  return items.length > 0 ? items : null;
}

export function createPlanRun(
  items: string[],
  preTurnHistory: ChatMessage[],
  anchorMessage: ChatMessage
): PlanRunState {
  return {
    items: items.map(text => ({ text, status: 'pending' as PlanItemStatus })),
    currentIndex: 0,
    handoffNotes: [],
    itemStartIndex: 0,
    itemToolRounds: 0,
    itemBudgetNudged: false,
    itemRetried: false,
    preTurnHistory,
    anchorMessage,
  };
}

/** Markdown rendering of the accepted plan for the chat output. */
export function renderPlanMarkdown(items: string[]): string {
  return ['**Plan**', ...items.map((item, i) => `${i + 1}. ${item}`)].join('\n');
}

/** Plain-text plan with status markers, for the model's step context. */
function renderPlanStatusList(state: PlanRunState): string {
  return state.items
    .map((item, i) => {
      const marker =
        i === state.currentIndex ? 'CURRENT' :
        item.status === 'done' ? 'done' :
        item.status === 'failed' ? 'incomplete' : 'pending';
      return `${i + 1}. [${marker}] ${item.text}`;
    })
    .join('\n');
}

/**
 * Build the per-step context message. Together with the pre-turn history and
 * the anchor message, this is the entire context for the step.
 */
export function buildItemContextMessage(
  state: PlanRunState,
  scratchpad: string,
  retryCritique?: string,
  previousAttemptHandoff?: string
): string {
  const item = state.items[state.currentIndex];
  const n = state.currentIndex + 1;
  const total = state.items.length;
  const lines: string[] = [
    `[Plan execution — step ${n} of ${total}]`,
    'Plan:',
    renderPlanStatusList(state),
  ];

  if (state.handoffNotes.length > 0) {
    lines.push('', 'Notes from completed steps:', ...state.handoffNotes);
  }
  if (scratchpad) {
    lines.push('', 'Scratchpad (.agent86/scratchpad.md):', scratchpad);
  }
  if (retryCritique) {
    lines.push(
      '',
      `The previous attempt at this step was judged incomplete: ${retryCritique}`,
      previousAttemptHandoff ? `Actions taken in the previous attempt:\n${previousAttemptHandoff}` : '',
      'Fix what is missing — do not redo work that already succeeded.'
    );
  }

  lines.push(
    '',
    `You are executing step ${n} only: "${item.text}"`,
    'Do only this step — not later steps. Use tools as needed.',
    'When this step is done, reply in plain text with 1-3 sentences stating exactly what you did. Do not call more tools after the step is complete.'
  );

  return lines.filter(l => l !== undefined).join('\n');
}

function firstLine(text: string, maxChars = 140): string {
  const line = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
  return line.trim().slice(0, maxChars);
}

function describeEditTarget(toolName: string, input: Record<string, unknown>): string {
  const p = String(input['path'] ?? input['source'] ?? '').replace(/\\/g, '/');
  return p ? `${toolName} ${p}` : toolName;
}

const EDIT_TOOLS = new Set(['write_file', 'string_replace', 'copy_file', 'move_file', 'delete_file', 'create_directory']);

/**
 * Mechanical handoff note for a finished step: what was read, edited, run,
 * and what went wrong. Assembled from the step's transcript — no LLM call.
 */
export function buildItemHandoff(
  itemText: string,
  itemIndex: number,
  transcript: ChatMessage[],
  finalText: string
): string {
  const reads: string[] = [];
  const searches: string[] = [];
  const edits: string[] = [];
  const commands: string[] = [];
  const errors: string[] = [];

  const resultById = new Map<string, string>();
  for (const msg of transcript) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      resultById.set(msg.tool_call_id, msg.content);
    }
  }

  for (const msg of transcript) {
    if (msg.role !== 'assistant' || !msg.tool_calls) { continue; }
    for (const tc of msg.tool_calls) {
      const input = tc.input ?? {};
      const result = resultById.get(tc.toolCallId) ?? '';
      const failed = result.startsWith('Error');
      if (failed) {
        const head = firstLine(result, 120);
        if (!errors.includes(head)) { errors.push(head); }
      }
      if (tc.toolName === 'read_file') {
        const p = String(input['path'] ?? '').replace(/\\/g, '/');
        if (p && !reads.includes(p)) { reads.push(p); }
      } else if (tc.toolName === 'search_file_contents') {
        const pattern = String(input['pattern'] ?? '');
        if (pattern && !searches.includes(pattern)) { searches.push(pattern); }
      } else if (EDIT_TOOLS.has(tc.toolName)) {
        edits.push(`${describeEditTarget(tc.toolName, input)} (${failed ? 'FAILED' : 'ok'})`);
      } else if (tc.toolName === 'execute_bash') {
        const cmd = String(input['command'] ?? '').slice(0, 80);
        commands.push(`${cmd} → ${firstLine(result, 100) || '(no output)'}`);
      }
    }
  }

  const lines: string[] = [`Step ${itemIndex + 1} (${itemText}):`];
  if (edits.length > 0) { lines.push(`- Edits: ${edits.join('; ')}`); }
  if (commands.length > 0) { lines.push(...commands.map(c => `- Ran: ${c}`)); }
  if (reads.length > 0) { lines.push(`- Read: ${reads.join(', ')}`); }
  if (searches.length > 0) { lines.push(`- Searched: ${searches.map(s => `"${s}"`).join(', ')}`); }
  if (errors.length > 0) { lines.push(`- Errors: ${errors.join('; ')}`); }
  if (finalText.trim()) { lines.push(`- Outcome: ${finalText.trim().replace(/\s+/g, ' ').slice(0, 500)}`); }
  return lines.join('\n');
}

const MAX_EVIDENCE_CHARS = 6000;
const MAX_EDIT_DETAIL_CHARS = 400;

/**
 * Evidence block for the fixed-function verifier: includes capped edit
 * contents so the judge can see *what* changed, not just which files.
 */
export function buildVerifierEvidence(transcript: ChatMessage[], finalText: string): string {
  const parts: string[] = [];

  const resultById = new Map<string, string>();
  for (const msg of transcript) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      resultById.set(msg.tool_call_id, msg.content);
    }
  }

  for (const msg of transcript) {
    if (msg.role !== 'assistant' || !msg.tool_calls) { continue; }
    for (const tc of msg.tool_calls) {
      const input = tc.input ?? {};
      const result = resultById.get(tc.toolCallId) ?? '';
      const status = result.startsWith('Error') ? `FAILED: ${firstLine(result, 100)}` : 'ok';
      if (tc.toolName === 'string_replace') {
        parts.push(
          `string_replace ${String(input['path'] ?? '')} (${status})\n` +
          `  old: ${String(input['old_str'] ?? '').slice(0, MAX_EDIT_DETAIL_CHARS)}\n` +
          `  new: ${String(input['new_str'] ?? '').slice(0, MAX_EDIT_DETAIL_CHARS)}`
        );
      } else if (tc.toolName === 'write_file') {
        const content = String(input['content'] ?? '');
        parts.push(
          `write_file ${String(input['path'] ?? '')} (${status}, ${content.length} chars)\n` +
          `  content head: ${content.slice(0, MAX_EDIT_DETAIL_CHARS)}`
        );
      } else if (EDIT_TOOLS.has(tc.toolName)) {
        parts.push(`${describeEditTarget(tc.toolName, input)} (${status})`);
      } else if (tc.toolName === 'execute_bash') {
        const out = result.split(/\r?\n/).slice(0, 3).join('\n');
        parts.push(`execute_bash: ${String(input['command'] ?? '').slice(0, 120)}\n  output: ${out.slice(0, 300)}`);
      } else if (tc.toolName === 'read_file') {
        parts.push(`read_file ${String(input['path'] ?? '')}`);
      }
    }
  }

  if (finalText.trim()) {
    parts.push(`Agent's own summary: ${finalText.trim().replace(/\s+/g, ' ').slice(0, 600)}`);
  }

  let evidence = parts.join('\n');
  if (evidence.length > MAX_EVIDENCE_CHARS) {
    evidence = `${evidence.slice(0, MAX_EVIDENCE_CHARS)}\n[... evidence truncated ...]`;
  }
  return evidence || '(no tool activity recorded for this step)';
}

/** Final user-facing summary once all steps have run. */
export function buildPlanSummary(state: PlanRunState): string {
  const succeeded = state.items.filter(i => i.status === 'done').length;
  const lines: string[] = [
    `**Plan complete** — ${succeeded}/${state.items.length} step(s) succeeded.`,
    '',
  ];
  state.items.forEach((item, i) => {
    const mark = item.status === 'done' ? '✓' : '✗';
    lines.push(`${i + 1}. ${mark} ${item.text}${item.outcome ? ` — ${item.outcome}` : ''}`);
  });
  return lines.join('\n');
}
