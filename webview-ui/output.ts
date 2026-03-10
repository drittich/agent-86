/**
 * Output/markdown rendering module.
 * Manages the segments buffer, markdown flush cycle, and tool accordion rendering.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml } from './utils';

// ── Module state ──────────────────────────────────────────────────────────────

let outputEl: HTMLElement;

export type OutputSegment =
  | { type: 'md'; content: string }
  | { type: 'user'; content: string }
  | { type: 'activity'; label: string; detail?: string };
export let segments: OutputSegment[] = [];

let renderTimer: ReturnType<typeof setTimeout> | null = null;
const RENDER_INTERVAL_MS = 100;

/** Tracks edit outcomes by URI so accordions can show "Edited" vs "Editing". */
export const editOutcomes = new Map<string, 'applied' | 'cancelled'>();

const EMPTY_STATE_HTML = DOMPurify.sanitize(
  '<p class="empty-state">Configure a provider in settings, then type a message to get started.</p>'
);

// Known tool keys and their display labels
const TOOL_KEYS: Record<string, string> = {
  edits: 'edits',
  search_file: 'search_file',
  request_chunks: 'request_chunks',
  request_files: 'request_files',
  request_search: 'request_search',
};

// ── Init ──────────────────────────────────────────────────────────────────────

export function initOutput(el: HTMLElement): void {
  outputEl = el;
  outputEl.innerHTML = EMPTY_STATE_HTML;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getMdBuffer(): string {
  return segments
    .filter((s): s is { type: 'md'; content: string } => s.type === 'md')
    .map(s => s.content)
    .join('');
}

/**
 * Detect which tool key (if any) a parsed JSON object represents.
 * Returns the key name or null.
 */
function detectToolKey(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) { return null; }
  for (const key of Object.keys(TOOL_KEYS)) {
    if (Array.isArray((parsed as Record<string, unknown>)[key])) {
      return key;
    }
  }
  return null;
}

/**
 * Replace JSON tool blocks (bare or ```json fenced) with collapsed <details>
 * accordions. Handles edits, search_file, request_chunks, request_files, etc.
 */
export function replaceEditJsonWithAccordions(md: string): string {
  const result: string[] = [];
  let lastIndex = 0;

  // Regex: matches ```json\n{...}\n``` fenced blocks
  const fencedRe = /```json\s*(\{[\s\S]*?\})\s*```/g;
  let fencedMatch: RegExpExecArray | null;
  const fencedMatches: Array<{ index: number; end: number; json: string; key: string }> = [];
  while ((fencedMatch = fencedRe.exec(md)) !== null) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      const key = detectToolKey(parsed);
      if (key) {
        fencedMatches.push({ index: fencedMatch.index, end: fencedMatch.index + fencedMatch[0].length, json: fencedMatch[1], key });
      }
    } catch { /* not valid JSON */ }
  }

  const fencedRanges = fencedMatches.map(m => [m.index, m.end]);
  function isInFencedRange(idx: number): boolean {
    return fencedRanges.some(([s, e]) => idx >= s && idx < e);
  }

  // Extract bare JSON candidates (top-level { }) not inside fences
  const bareMatches: Array<{ index: number; end: number; json: string; key: string }> = [];
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
      if (depth === 0) { start = i; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        if (!isInFencedRange(start)) {
          const candidate = md.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            const key = detectToolKey(parsed);
            if (key) {
              bareMatches.push({ index: start, end: i + 1, json: candidate, key });
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
    result.push(buildToolAccordionHtml(match.key, match.json));
    lastIndex = match.end;
  }
  result.push(md.slice(lastIndex));
  return result.join('');
}

export function buildToolAccordionHtml(key: string, json: string): string {
  let title: string;

  if (key === 'edits') {
    let files: string[] = [];
    try {
      const parsed = JSON.parse(json);
      if (parsed && Array.isArray(parsed.edits)) {
        const uris: string[] = parsed.edits.map((e: { uri?: string }) => e.uri).filter(Boolean);
        files = [...new Set(uris)];
      }
    } catch { /* ignore */ }

    if (files.length === 0) {
      title = 'edits';
    } else {
      const outcome = editOutcomes.get(files[0]);
      const verb = outcome === 'applied' ? 'Edited' : outcome === 'cancelled' ? 'Edit cancelled:' : 'Editing';
      title = `${verb} ${files.join(', ')}`;
    }
  } else {
    title = key;
  }

  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `\n<details class="edit-accordion"><summary>${title}</summary><pre><code>${escaped}</code></pre></details>\n`;
}

// ── Core output functions ─────────────────────────────────────────────────────

export function flushMarkdown(): void {
  const wasAtBottom =
    outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 8;
  const hasContent = segments.some(s => s.type === 'user' || (s.type === 'md' && s.content));
  if (!hasContent) {
    outputEl.innerHTML = EMPTY_STATE_HTML;
    return;
  }
  let html = '';
  for (const seg of segments) {
    if (seg.type === 'user') {
      html += `<div class="user-bubble">${escapeHtml(seg.content)}</div>`;
    } else if (seg.type === 'activity') {
      const detail = seg.detail ? ` ${escapeHtml(seg.detail)}` : '';
      html += `<div class="tool-activity"><strong>${escapeHtml(seg.label)}</strong>${detail}</div>`;
    } else if (seg.content) {
      const processedMd = replaceEditJsonWithAccordions(seg.content);
      html += DOMPurify.sanitize(marked.parse(processedMd) as string);
    }
  }
  outputEl.innerHTML = html || EMPTY_STATE_HTML;
  if (wasAtBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

export function appendOutput(text: string): void {
  const last = segments[segments.length - 1];
  if (last && last.type === 'md') {
    last.content += text;
  } else {
    segments.push({ type: 'md', content: text });
  }
  if (renderTimer === null) {
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushMarkdown();
    }, RENDER_INTERVAL_MS);
  }
}

export function insertUserPrompt(text: string): void {
  segments.push({ type: 'user', content: text });
  flushMarkdown();
}

export function insertActivity(label: string, detail?: string): void {
  segments.push({ type: 'activity', label, detail });
  flushMarkdown();
}

export function clearOutput(): void {
  segments = [];
  editOutcomes.clear();
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  outputEl.innerHTML = EMPTY_STATE_HTML;
}

export function clearRenderTimer(): void {
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
}
