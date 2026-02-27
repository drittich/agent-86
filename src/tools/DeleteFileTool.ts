import * as vscode from 'vscode';
import * as path from 'path';

/**
 * @@DELETE Structured Delete Block Format
 * ========================================
 *
 * The model may include one or more `@@DELETE` blocks in its assistant message
 * to request deletion of a file within the workspace. The extension host parses
 * these blocks, shows an approval card, and—after explicit user approval—moves
 * the file to the OS trash (recycle bin) so it can be recovered if needed.
 *
 * ## Block syntax
 *
 * ```
 * @@DELETE
 * PATH: path/to/file.ts
 * @@END
 * ```
 *
 * Rules:
 *  - `@@DELETE` — opens a block.
 *  - `@@END` — closes the block.
 *  - `PATH:` specifies the file to delete (relative to workspace root or absolute).
 *  - The path must be inside the workspace; the operation is rejected otherwise.
 *  - The file must exist.
 *  - The file is moved to the OS trash (useTrash: true) so it can be recovered.
 *  - Multiple `@@DELETE` blocks in a single message are processed in order.
 *
 * ## Example
 *
 * ```
 * @@DELETE
 * PATH: src/utils/legacy.ts
 * @@END
 * ```
 */

export interface DeleteBlock {
  /** Path as written in the block (may be relative or absolute). */
  filePath: string;
}

export interface DeleteResult {
  filePath: string;
  /** True if the deletion succeeded. */
  success: boolean;
  /** Error message if deletion failed. */
  error?: string;
}

const DELETE_OPEN = '@@DELETE';
const DELETE_END = '@@END';

/**
 * Parse all `@@DELETE` blocks from an assistant message.
 * Returns an array of DeleteBlock objects (empty if none found).
 */
export function parseDeleteBlocks(text: string): DeleteBlock[] {
  const lines = text.split('\n');
  const blocks: DeleteBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== DELETE_OPEN) {
      i++;
      continue;
    }
    i++;

    let filePath: string | undefined;

    while (i < lines.length && lines[i].trimEnd() !== DELETE_END) {
      const line = lines[i].trim();
      if (line.startsWith('PATH:')) {
        filePath = line.slice('PATH:'.length).trim();
      }
      i++;
    }

    if (i < lines.length) {
      i++; // consume @@END
    }

    if (filePath) {
      blocks.push({ filePath });
    }
  }

  return blocks;
}

/**
 * Resolve a path that may be relative (to wsRoot) or absolute.
 * Returns null if the resolved path is outside all workspace roots.
 */
export function resolveDeleteBlockPath(
  p: string,
  wsRoots: string[]
): string | null {
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
 * Delete (trash) a file within the workspace.
 * Prefers moving to trash so the user can recover the file if needed.
 *
 * Never throws — errors are reflected in the returned `DeleteResult`.
 */
export async function deleteFile(fileAbsolute: string): Promise<DeleteResult> {
  const fileUri = vscode.Uri.file(fileAbsolute);

  try {
    // Ensure the file exists
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      return {
        filePath: fileAbsolute,
        success: false,
        error: `File not found: ${fileAbsolute}`,
      };
    }

    // Move to trash (recoverable); falls back to permanent delete if trash unavailable
    await vscode.workspace.fs.delete(fileUri, { useTrash: true });

    return { filePath: fileAbsolute, success: true };
  } catch (err) {
    return {
      filePath: fileAbsolute,
      success: false,
      error: String(err),
    };
  }
}

/**
 * Format a DeleteResult as a compact summary to feed back to the model.
 */
export function formatDeleteResult(result: DeleteResult): string {
  if (result.success) {
    return `@@DELETE_RESULT\npath: ${result.filePath}\nstatus: success (moved to trash)`;
  }
  return `@@DELETE_RESULT\npath: ${result.filePath}\nstatus: failed\nerror: ${result.error}`;
}
