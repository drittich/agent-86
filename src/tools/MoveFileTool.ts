import * as vscode from 'vscode';
import * as path from 'path';

/**
 * <MOVE> Structured Move Block Format
 * =====================================
 *
 * The model may include one or more `<MOVE>` blocks in its assistant message to
 * request moving (renaming) a file within the workspace. The extension host parses
 * these blocks, shows an approval card, and—after explicit user approval—performs
 * the move using the VS Code workspace filesystem API.
 *
 * ## Block syntax
 *
 * ```
 * <MOVE>
 * FROM: path/to/source.ts
 * TO: path/to/destination.ts
 * </MOVE>
 * ```
 *
 * Rules:
 *  - `<MOVE>` — opens a block.
 *  - `</MOVE>` — closes the block.
 *  - `FROM:` specifies the source path (relative to workspace root or absolute).
 *  - `TO:` specifies the destination path (relative to workspace root or absolute).
 *  - Both paths must be inside the workspace; the operation is rejected otherwise.
 *  - The source file must exist.
 *  - If the destination directory does not exist, it is created automatically.
 *  - Multiple `<MOVE>` blocks in a single message are processed in order.
 *
 * ## Example
 *
 * ```
 * <MOVE>
 * FROM: src/utils/helper.ts
 * TO: src/shared/helper.ts
 * </MOVE>
 * ```
 */

export interface MoveBlock {
  /** Source path as written in the block (may be relative or absolute). */
  from: string;
  /** Destination path as written in the block (may be relative or absolute). */
  to: string;
}

export interface MoveResult {
  from: string;
  to: string;
  /** True if the move succeeded. */
  success: boolean;
  /** Error message if the move failed. */
  error?: string;
}

const MOVE_OPEN = '<MOVE>';
const MOVE_END = '</MOVE>';

/**
 * Parse all `<MOVE>` blocks from an assistant message.
 * Returns an array of MoveBlock objects (empty if none found).
 */
export function parseMoveBlocks(text: string): MoveBlock[] {
  const lines = text.split('\n');
  const blocks: MoveBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== MOVE_OPEN) {
      i++;
      continue;
    }
    i++;

    let from: string | undefined;
    let to: string | undefined;

    while (i < lines.length && lines[i].trimEnd() !== MOVE_END) {
      const line = lines[i].trim();
      if (line.startsWith('FROM:')) {
        from = line.slice('FROM:'.length).trim();
      } else if (line.startsWith('TO:')) {
        to = line.slice('TO:'.length).trim();
      }
      i++;
    }

    if (i < lines.length) {
      i++; // consume </MOVE>
    }

    if (from && to) {
      blocks.push({ from, to });
    }
  }

  return blocks;
}

/**
 * Resolve a path that may be relative (to wsRoot) or absolute.
 * Returns null if the resolved path is outside all workspace roots.
 */
export function resolveMoveBlockPath(
  p: string,
  wsRoots: string[]
): string | null {
  // If already absolute, use as-is; otherwise resolve against first workspace root
  const resolved = path.isAbsolute(p)
    ? p
    : path.resolve(wsRoots[0], p);

  const normalised = path.normalize(resolved);
  const inWorkspace = wsRoots.some(
    (root) => normalised === root || normalised.startsWith(root + path.sep)
  );

  return inWorkspace ? normalised : null;
}

/**
 * Move (rename) a file within the workspace. Creates intermediate destination
 * directories if needed.
 *
 * Never throws — errors are reflected in the returned `MoveResult`.
 */
export async function moveFile(
  fromAbsolute: string,
  toAbsolute: string
): Promise<MoveResult> {
  const fromUri = vscode.Uri.file(fromAbsolute);
  const toUri = vscode.Uri.file(toAbsolute);

  try {
    // Ensure the source exists
    try {
      await vscode.workspace.fs.stat(fromUri);
    } catch {
      return {
        from: fromAbsolute,
        to: toAbsolute,
        success: false,
        error: `Source file not found: ${fromAbsolute}`,
      };
    }

    // Create destination directory if needed
    const toDir = path.dirname(toAbsolute);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(toDir));

    // Perform the rename (copy + delete)
    await vscode.workspace.fs.rename(fromUri, toUri, { overwrite: false });

    return { from: fromAbsolute, to: toAbsolute, success: true };
  } catch (err) {
    return {
      from: fromAbsolute,
      to: toAbsolute,
      success: false,
      error: String(err),
    };
  }
}

/**
 * Format a MoveResult as a compact summary to feed back to the model.
 */
export function formatMoveResult(result: MoveResult): string {
  if (result.success) {
    return `<MOVE_RESULT from="${result.from}" to="${result.to}" status="success"/>`;
  }
  return `<MOVE_RESULT from="${result.from}" to="${result.to}" status="failed" error="${result.error}"/>`;
}
