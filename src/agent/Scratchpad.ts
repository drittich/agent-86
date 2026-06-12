import * as fs from 'fs';
import * as path from 'path';

/**
 * Harness-owned scratchpad file at `.agent86/scratchpad.md`.
 *
 * State that must survive per-step context resets lives here, not in the
 * conversation: the harness overwrites it at plan start, appends each step's
 * handoff note, and re-injects the (capped) content into every step context.
 * All operations are best-effort — scratchpad failures never break a run.
 */

const SCRATCHPAD_MAX_INJECT_CHARS = 4000;

function scratchpadPath(wsRoot: string): string {
  return path.join(wsRoot, '.agent86', 'scratchpad.md');
}

/** Overwrite the scratchpad with a fresh header for a new plan run. */
export function initScratchpad(wsRoot: string, task: string, items: string[]): void {
  if (!wsRoot) { return; }
  try {
    const file = scratchpadPath(wsRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = [
      '# Agent 86 scratchpad',
      '',
      `Task: ${task.replace(/\s+/g, ' ').slice(0, 300)}`,
      '',
      'Plan:',
      ...items.map((item, i) => `${i + 1}. ${item}`),
      '',
    ].join('\n');
    fs.writeFileSync(file, content, 'utf8');
  } catch {
    // best-effort
  }
}

/** Append a section (e.g. a step's handoff note) to the scratchpad. */
export function appendScratchpad(wsRoot: string, section: string): void {
  if (!wsRoot || !section.trim()) { return; }
  try {
    const file = scratchpadPath(wsRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `\n${section.trim()}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * Read the scratchpad for injection into a step context.
 * Tail-truncated: the header (task + plan) is re-stated by the step context
 * anyway, so when over budget the most recent notes win.
 */
export function readScratchpad(wsRoot: string, maxChars = SCRATCHPAD_MAX_INJECT_CHARS): string {
  if (!wsRoot) { return ''; }
  try {
    const content = fs.readFileSync(scratchpadPath(wsRoot), 'utf8').trim();
    if (content.length <= maxChars) { return content; }
    return `[... earlier scratchpad content truncated ...]\n${content.slice(-maxChars)}`;
  } catch {
    return '';
  }
}
