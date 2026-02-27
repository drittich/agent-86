import * as path from 'path';

/**
 * @@EDIT Structured Edit Block Format
 * ====================================
 *
 * The model produces one or more `@@EDIT` blocks inside its assistant message
 * to describe file modifications. The extension host parses these blocks,
 * validates them, shows a diff preview, and—after explicit user approval—
 * applies the edits via `vscode.workspace.fs.writeFile`.
 *
 * ## Block syntax
 *
 * ```
 * @@EDIT path/to/file.ts
 * @@FROM
 * <exact text that currently exists in the file>
 * @@TO
 * <replacement text>
 * @@END
 * ```
 *
 * Rules:
 *  - `@@EDIT <path>` — opens a block. `<path>` is the workspace-relative path
 *    (forward slashes on all platforms). The path MUST NOT start with `/`,
 *    `..`, or contain drive letters. Paths outside the workspace root are
 *    rejected.
 *  - `@@FROM` — delimiter that begins the "search" text.
 *  - `@@TO` — delimiter that separates search text from replacement text.
 *  - `@@END` — closes the block. The newline immediately before `@@END` is
 *    NOT part of the replacement text (strip it).
 *  - Leading/trailing blank lines inside `@@FROM`/`@@TO` sections are
 *    significant and preserved.
 *  - Multiple `@@EDIT` blocks may appear in a single assistant message and
 *    are applied in the order they appear.
 *  - A block with an empty `@@FROM` section is a **full-file replacement**:
 *    the entire file is overwritten with the `@@TO` content.
 *  - A block with an empty `@@TO` section **deletes** the matched text.
 *
 * ## Example — partial edit
 *
 * ```
 * @@EDIT src/utils/math.ts
 * @@FROM
 * function add(a: number, b: number) {
 *   return a + b;
 * }
 * @@TO
 * function add(a: number, b: number): number {
 *   return a + b;
 * }
 * @@END
 * ```
 *
 * ## Example — full-file replacement
 *
 * ```
 * @@EDIT src/hello.ts
 * @@FROM
 * @@TO
 * console.log('hello world');
 * @@END
 * ```
 *
 * ## Example — delete a block
 *
 * ```
 * @@EDIT src/hello.ts
 * @@FROM
 * // TODO: remove this
 * console.log('debug');
 * @@TO
 * @@END
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

const EDIT_OPEN_RE = /^@@EDIT[ \t]+(.+)$/;
const FROM_MARKER = '@@FROM';
const TO_MARKER = '@@TO';
const END_MARKER = '@@END';

/**
 * Resolve a workspace-relative path against the workspace roots and verify
 * the resulting absolute path is actually inside one of those roots.
 *
 * Returns the resolved absolute path (using the first matching workspace root)
 * or an error message string if the path is invalid or escapes the workspace.
 *
 * @param relativePath  The workspace-relative path from an @@EDIT block.
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

/**
 * Parse all `@@EDIT` blocks found in an assistant message.
 *
 * Returns `{ blocks, warnings }`. Individual malformed blocks are skipped and
 * a warning is added; valid blocks are still returned.
 */
export function parseEditBlocks(text: string): ParseResult {
  const lines = text.split('\n');
  const blocks: EditBlock[] = [];
  const warnings: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const openMatch = EDIT_OPEN_RE.exec(lines[i]);
    if (!openMatch) {
      i++;
      continue;
    }

    const path = openMatch[1].trim();
    const blockStart = i;
    i++;

    // Expect @@FROM next
    if (i >= lines.length || lines[i].trimEnd() !== FROM_MARKER) {
      warnings.push(`@@EDIT block at line ${blockStart + 1}: expected @@FROM, got "${lines[i] ?? '<EOF>'}"`);
      continue;
    }
    i++;

    // Collect FROM lines until @@TO
    const fromLines: string[] = [];
    while (i < lines.length && lines[i].trimEnd() !== TO_MARKER) {
      if (lines[i].trimEnd() === END_MARKER) {
        warnings.push(`@@EDIT block at line ${blockStart + 1}: reached @@END before @@TO`);
        break;
      }
      fromLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length || lines[i].trimEnd() !== TO_MARKER) {
      warnings.push(`@@EDIT block at line ${blockStart + 1}: @@TO marker not found`);
      continue;
    }
    i++;

    // Collect TO lines until @@END
    const toLines: string[] = [];
    while (i < lines.length && lines[i].trimEnd() !== END_MARKER) {
      toLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length || lines[i].trimEnd() !== END_MARKER) {
      warnings.push(`@@EDIT block at line ${blockStart + 1}: @@END marker not found`);
      continue;
    }
    i++; // consume @@END

    // Strip the trailing newline that the model emits before @@TO / @@END
    const from = joinAndStripTrailingNewline(fromLines);
    const to = joinAndStripTrailingNewline(toLines);

    const pathError = validatePath(path);
    if (pathError) {
      warnings.push(`@@EDIT block at line ${blockStart + 1}: invalid path — ${pathError}`);
      continue;
    }

    blocks.push({ path, from, to });
  }

  return { blocks, warnings };
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
