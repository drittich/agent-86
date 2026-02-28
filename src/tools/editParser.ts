import * as path from 'path';

/**
 * JSON Anchor-Based Edit Format
 * ==============================
 *
 * The model produces a JSON object with an "edits" array anywhere in its
 * assistant message. The extension parses this, shows a diff preview, and—
 * after user approval—applies the edits via VS Code WorkspaceEdit.
 *
 * ## JSON shape
 *
 * ```json
 * {
 *   "edits": [
 *     {
 *       "uri": "src/file.ts",
 *       "op": "replace_first",
 *       "anchor": "exact text currently in the file",
 *       "text": "replacement text"
 *     }
 *   ]
 * }
 * ```
 *
 * ## Operations
 *
 * - "replace_first" — replaces the first occurrence of "anchor" with "text"
 * - "delete_first"  — deletes the first occurrence of "anchor" (omit "text")
 * - "insert_after"  — inserts "text" immediately after the first occurrence of "anchor"
 * - "insert_before" — inserts "text" immediately before the first occurrence of "anchor"
 * - "replace_all"   — replaces the entire file content with "text" (omit "anchor")
 *
 * ## Rules
 * - "uri" is workspace-relative, forward slashes, no leading slash.
 * - "anchor" must match the file exactly (whitespace included).
 * - Multiple edits may appear in a single "edits" array and are applied in order.
 * - The JSON may be wrapped in a ```json code fence.
 */

export type AnchorOp = 'insert_after' | 'insert_before' | 'replace_first' | 'delete_first' | 'replace_all';

export interface AnchorEditOp {
  /** Workspace-relative path (forward slashes, no leading slash). */
  uri: string;
  /** Operation to perform. */
  op: AnchorOp;
  /**
   * Text to locate in the file. Required for all ops except replace_all.
   * For insert_after/insert_before: the insertion anchor point.
   * For replace_first/delete_first: the text to replace/delete.
   */
  anchor?: string;
  /**
   * Replacement / inserted text.
   * Omitted or empty for delete_first.
   * Required for insert_after, insert_before, replace_first, replace_all.
   */
  text?: string;
}

/** Result of parsing an assistant message. */
export interface ParseResult {
  ops: AnchorEditOp[];
  /** Non-fatal warnings encountered during parsing. */
  warnings: string[];
}

const VALID_OPS = new Set<string>(['insert_after', 'insert_before', 'replace_first', 'delete_first', 'replace_all']);

/**
 * Extract all top-level JSON object substrings from text.
 * Walks char-by-char tracking brace depth and skipping string literals.
 */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

/** Strip markdown code fences (``` or ~~~, with optional language tag) from text. */
function stripCodeFences(text: string): string {
  return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n/gm, '');
}

/**
 * Parse all edit operations from an assistant message.
 *
 * Scans for any JSON object containing an "edits" array, validates each op,
 * and returns the collected operations plus any warnings.
 */
export function parseEditOps(text: string): ParseResult {
  const ops: AnchorEditOp[] = [];
  const warnings: string[] = [];

  const strippedText = stripCodeFences(text);
  const candidates = extractJsonCandidates(strippedText);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)['edits'])
    ) {
      continue;
    }

    const edits = (parsed as { edits: unknown[] }).edits;

    for (let i = 0; i < edits.length; i++) {
      const item = edits[i];
      if (typeof item !== 'object' || item === null) {
        warnings.push(`edits[${i}]: not an object`);
        continue;
      }

      const obj = item as Record<string, unknown>;

      if (typeof obj['uri'] !== 'string' || !obj['uri']) {
        warnings.push(`edits[${i}]: missing or invalid "uri"`);
        continue;
      }

      if (typeof obj['op'] !== 'string' || !VALID_OPS.has(obj['op'])) {
        warnings.push(`edits[${i}]: invalid "op" "${obj['op']}"`);
        continue;
      }

      const op = obj['op'] as AnchorOp;

      if (op !== 'replace_all' && (typeof obj['anchor'] !== 'string' || !obj['anchor'])) {
        warnings.push(`edits[${i}]: op "${op}" requires a non-empty "anchor"`);
        continue;
      }

      const pathError = validatePath(obj['uri'] as string);
      if (pathError) {
        warnings.push(`edits[${i}]: invalid uri — ${pathError}`);
        continue;
      }

      ops.push({
        uri: obj['uri'] as string,
        op,
        anchor: typeof obj['anchor'] === 'string' ? obj['anchor'] : undefined,
        text: typeof obj['text'] === 'string' ? obj['text'] : '',
      });
    }
  }

  return { ops, warnings };
}

/**
 * Apply an anchor edit operation to the given file content.
 *
 * Returns the new file content string, or an `{ error }` object if the
 * operation cannot be applied (anchor not found, anchor ambiguous).
 */
export function applyAnchorOp(
  op: AnchorEditOp,
  fileContent: string
): string | { error: string } {
  const text = op.text ?? '';

  if (op.op === 'replace_all') {
    return text;
  }

  const anchor = op.anchor!;
  const firstIndex = fileContent.indexOf(anchor);

  if (firstIndex === -1) {
    return { error: `anchor not found in "${op.uri}"` };
  }

  const secondIndex = fileContent.indexOf(anchor, firstIndex + anchor.length);
  if (secondIndex !== -1) {
    return { error: `anchor is ambiguous (found more than once) in "${op.uri}"` };
  }

  switch (op.op) {
    case 'replace_first':
      return fileContent.slice(0, firstIndex) + text + fileContent.slice(firstIndex + anchor.length);
    case 'delete_first':
      return fileContent.slice(0, firstIndex) + fileContent.slice(firstIndex + anchor.length);
    case 'insert_after':
      return fileContent.slice(0, firstIndex + anchor.length) + text + fileContent.slice(firstIndex + anchor.length);
    case 'insert_before':
      return fileContent.slice(0, firstIndex) + text + fileContent.slice(firstIndex);
  }
}

/**
 * Resolve a workspace-relative path against the workspace roots and verify
 * the resulting absolute path is actually inside one of those roots.
 *
 * Returns the resolved absolute path (using the first matching workspace root)
 * or an error message string if the path is invalid or escapes the workspace.
 */
export function resolveEditPath(
  relativePath: string,
  wsRoots: string[]
): { resolvedPath: string; error?: undefined } | { resolvedPath?: undefined; error: string } {
  if (wsRoots.length === 0) {
    return { error: 'no workspace folder is open' };
  }

  const formatError = validatePath(relativePath);
  if (formatError) {
    return { error: formatError };
  }

  const normalized = relativePath.replace(/\//g, path.sep);

  for (const root of wsRoots) {
    const resolved = path.resolve(root, normalized);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return { resolvedPath: resolved };
    }
  }

  return { error: `path "${relativePath}" resolves outside all workspace folders` };
}

/**
 * Validate a workspace-relative path.
 * Returns an error message string if invalid, or `null` if valid.
 */
function validatePath(p: string): string | null {
  if (!p) {
    return 'path is empty';
  }
  if (p.startsWith('/') || p.startsWith('\\')) {
    return 'path must not be absolute';
  }
  if (/^[a-zA-Z]:/.test(p)) {
    return 'path must not contain a drive letter';
  }
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some(s => s === '..')) {
    return 'path must not contain ".." segments';
  }
  return null;
}
