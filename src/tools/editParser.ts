import * as path from 'path';

/**
 * <EDIT> Structured Edit Block Format
 * ====================================
 *
 * The model produces one or more `<EDIT>` blocks inside its assistant message
 * to describe file modifications. The extension host parses these blocks,
 * validates them, shows a diff preview, and—after explicit user approval—
 * applies the edits via `vscode.workspace.fs.writeFile`.
 *
 * ## Block syntax
 *
 * ```
 * <EDIT path="path/to/file.ts">
 * <FROM>
 * <exact text that currently exists in the file>
 * </FROM>
 * <TO>
 * <replacement text>
 * </TO>
 * </EDIT>
 * ```
 *
 * Rules:
 *  - `<EDIT path="...">` — opens a block. `path` is the workspace-relative path
 *    (forward slashes on all platforms). The path MUST NOT start with `/`,
 *    `..`, or contain drive letters. Paths outside the workspace root are
 *    rejected.
 *  - `<FROM>` / `</FROM>` — delimiters that wrap the "search" text.
 *  - `<TO>` / `</TO>` — delimiters that wrap the replacement text.
 *  - `</EDIT>` — closes the block.
 *  - Leading/trailing blank lines inside `<FROM>`/`<TO>` sections are
 *    significant and preserved.
 *  - Multiple `<EDIT>` blocks may appear in a single assistant message and
 *    are applied in the order they appear.
 *  - A block with an empty `<FROM>` section is a **full-file replacement**:
 *    the entire file is overwritten with the `<TO>` content.
 *  - A block with an empty `<TO>` section **deletes** the matched text.
 *
 * ## Example — partial edit
 *
 * ```
 * <EDIT path="src/utils/math.ts">
 * <FROM>
 * function add(a: number, b: number) {
 *   return a + b;
 * }
 * </FROM>
 * <TO>
 * function add(a: number, b: number): number {
 *   return a + b;
 * }
 * </TO>
 * </EDIT>
 * ```
 *
 * ## Example — full-file replacement
 *
 * ```
 * <EDIT path="src/hello.ts">
 * <FROM>
 * </FROM>
 * <TO>
 * console.log('hello world');
 * </TO>
 * </EDIT>
 * ```
 *
 * ## Example — delete a block
 *
 * ```
 * <EDIT path="src/hello.ts">
 * <FROM>
 * // TODO: remove this
 * console.log('debug');
 * </FROM>
 * <TO>
 * </TO>
 * </EDIT>
 * ```
 */

/** A fully parsed and validated edit block ready for preview/application. */
export interface EditBlock {
  /** Workspace-relative path (forward slashes, no leading slash). */
  path: string;
  /**
   * Text to find in the file. Empty string means full-file replacement
   * (match the entire current content).
   */
  from: string;
  /** Replacement text. Empty string means deletion of the `from` text. */
  to: string;
}

/** Result of parsing an assistant message. */
export interface ParseResult {
  blocks: EditBlock[];
  /** Non-fatal warnings encountered during parsing (e.g. extra whitespace). */
  warnings: string[];
}

const EDIT_OPEN_RE = /^<EDIT[ \t]+path="([^"]+)"[ \t]*>$/;
const FROM_OPEN  = '<FROM>';
const FROM_CLOSE = '</FROM>';
const TO_OPEN    = '<TO>';
const TO_CLOSE   = '</TO>';
const EDIT_CLOSE = '</EDIT>';

/**
 * Resolve a workspace-relative path against the workspace roots and verify
 * the resulting absolute path is actually inside one of those roots.
 *
 * Returns the resolved absolute path (using the first matching workspace root)
 * or an error message string if the path is invalid or escapes the workspace.
 *
 * @param relativePath  The workspace-relative path from an <EDIT> block.
 * @param wsRoots       Array of `fsPath` strings from `vscode.workspace.workspaceFolders`.
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

  // Normalise forward-slash separators to the platform separator
  const normalized = relativePath.replace(/\//g, path.sep);

  for (const root of wsRoots) {
    const resolved = path.resolve(root, normalized);
    // Ensure the resolved path starts with the workspace root + separator
    // (or equals it exactly, though that would be writing the root dir itself)
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return { resolvedPath: resolved };
    }
  }

  return { error: `path "${relativePath}" resolves outside all workspace folders` };
}

/** Strip markdown code fences (``` or ~~~, with optional language tag) from text. */
function stripCodeFences(text: string): string {
  // Remove lines that are solely opening/closing code fences
  return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n/gm, '');
}

/**
 * Parse all `<EDIT>` blocks found in an assistant message.
 *
 * Returns `{ blocks, warnings }`. Individual malformed blocks are skipped and
 * a warning is added; valid blocks are still returned.
 */
export function parseEditBlocks(text: string): ParseResult {
  // Strip markdown code fences so models that wrap <EDIT> in ``` blocks still parse.
  const lines = stripCodeFences(text).split('\n');
  const blocks: EditBlock[] = [];
  const warnings: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const openMatch = EDIT_OPEN_RE.exec(lines[i]);
    if (!openMatch) {
      i++;
      continue;
    }

    const filePath = openMatch[1].trim();
    const blockStart = i;
    i++;

    // Skip any blank lines between <EDIT> and <FROM> (weaker models may emit them)
    while (i < lines.length && lines[i].trim() === '') {
      i++;
    }

    // Expect <FROM> next
    if (i >= lines.length || lines[i].trimEnd() !== FROM_OPEN) {
      warnings.push(`<EDIT> block at line ${blockStart + 1}: expected ${FROM_OPEN}, got "${lines[i] ?? '<EOF>'}"`);
      continue;
    }
    i++;

    // Collect FROM lines until </FROM>
    const fromLines: string[] = [];
    while (i < lines.length && lines[i].trimEnd() !== FROM_CLOSE) {
      if (lines[i].trimEnd() === EDIT_CLOSE) {
        warnings.push(`<EDIT> block at line ${blockStart + 1}: reached ${EDIT_CLOSE} before ${FROM_CLOSE}`);
        break;
      }
      fromLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length || lines[i].trimEnd() !== FROM_CLOSE) {
      warnings.push(`<EDIT> block at line ${blockStart + 1}: ${FROM_CLOSE} marker not found`);
      continue;
    }
    i++;

    // Skip any blank lines between </FROM> and <TO>
    while (i < lines.length && lines[i].trim() === '') {
      i++;
    }

    // Expect <TO> next
    if (i >= lines.length || lines[i].trimEnd() !== TO_OPEN) {
      warnings.push(`<EDIT> block at line ${blockStart + 1}: expected ${TO_OPEN}, got "${lines[i] ?? '<EOF>'}"`);
      continue;
    }
    i++;

    // Collect TO lines until </TO>
    const toLines: string[] = [];
    while (i < lines.length && lines[i].trimEnd() !== TO_CLOSE) {
      toLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length || lines[i].trimEnd() !== TO_CLOSE) {
      warnings.push(`<EDIT> block at line ${blockStart + 1}: ${TO_CLOSE} marker not found`);
      continue;
    }
    i++;

    // Expect </EDIT> next
    if (i >= lines.length || lines[i].trimEnd() !== EDIT_CLOSE) {
      warnings.push(`<EDIT> block at line ${blockStart + 1}: expected ${EDIT_CLOSE}, got "${lines[i] ?? '<EOF>'}"`);
      continue;
    }
    i++; // consume </EDIT>

    // Strip the trailing newline that the model emits before closing tags
    const from = joinAndStripTrailingNewline(fromLines);
    const to = joinAndStripTrailingNewline(toLines);

    const pathError = validatePath(filePath);
    if (pathError) {
      warnings.push(`<EDIT> block at line ${blockStart + 1}: invalid path — ${pathError}`);
      continue;
    }

    blocks.push({ path: filePath, from, to });
  }

  return { blocks, warnings };
}

/**
 * Validate that the `from` text in an edit block exists exactly once in the
 * given file content.
 *
 * - If `block.from` is empty the block is a full-file replacement, which is
 *   always valid regardless of current content.
 * - Returns `null` if valid (from text found exactly once).
 * - Returns an error message string if the text is not found or is ambiguous
 *   (appears more than once).
 */
export function validateFromText(block: EditBlock, fileContent: string): string | null {
  // Empty FROM means full-file replacement — always valid.
  if (block.from === '') {
    return null;
  }

  const firstIndex = fileContent.indexOf(block.from);
  if (firstIndex === -1) {
    return `FROM text not found in "${block.path}"`;
  }

  const secondIndex = fileContent.indexOf(block.from, firstIndex + block.from.length);
  if (secondIndex !== -1) {
    return `FROM text is ambiguous — found more than once in "${block.path}"`;
  }

  return null;
}

/** Join lines back to a string, stripping one trailing newline if present. */
function joinAndStripTrailingNewline(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  const joined = lines.join('\n');
  // Strip a single trailing newline that the model adds before the next marker
  return joined.endsWith('\n') ? joined.slice(0, -1) : joined;
}

/**
 * Apply an edit block to the given file content, returning the new content.
 *
 * - If `block.from` is empty, replaces the entire file content with `block.to`.
 * - Otherwise, replaces the first occurrence of `block.from` with `block.to`.
 *
 * Assumes `validateFromText` has already confirmed the block is valid.
 */
export function applyEditBlock(block: EditBlock, fileContent: string): string {
  if (block.from === '') {
    return block.to;
  }
  return fileContent.replace(block.from, () => block.to);
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
