import * as vscode from 'vscode';
import * as path from 'path';
import { ToolCallEvent } from '../providers/IProvider';
import { runCommand } from './TerminalTool';
import { resolveMoveBlockPath, moveFile } from './MoveFileTool';
import { resolveDeleteBlockPath, deleteFile } from './DeleteFileTool';
import { searchFileWithRg } from './ChunkManager';
import { resolveEditPath } from './editParser';
import { FILE_EXCLUDE_GLOB } from './FileTools';

export interface ToolExecutorDeps {
  log: vscode.OutputChannel;
  postMessage: (message: unknown) => void;
  requestApproval: (action: string, payload: unknown, reason?: string) => Promise<boolean>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
}

/**
 * Executes a native tool call from the model, applying approval gates for
 * destructive or side-effecting operations.
 *
 * Returns a ToolResult whose `result` string is fed back to the model as a
 * tool message. Never throws — errors are captured in the result string.
 */
export class ToolExecutor {
  private readonly wsRoots: string[];
  private readonly wsRoot: string;

  constructor(
    private readonly deps: ToolExecutorDeps,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ) {
    this.wsRoots = workspaceFolders.map(f => f.uri.fsPath);
    this.wsRoot = this.wsRoots[0] ?? '';
  }

  async execute(call: ToolCallEvent): Promise<ToolResult> {
    const { toolCallId, toolName, args } = call;
    this.deps.log.appendLine(`[tool] ${toolName} ${JSON.stringify(args).slice(0, 200)}`);

    try {
      const result = await this._dispatch(toolName, args);
      return { toolCallId, result };
    } catch (err) {
      const msg = `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
      this.deps.log.appendLine(`[tool] error: ${msg}`);
      return { toolCallId, result: msg };
    }
  }

  private async _dispatch(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'read_file':         return this._readFile(args);
      case 'write_file':        return this._writeFile(args);
      case 'string_replace':    return this._stringReplace(args);
      case 'copy_file':         return this._copyFile(args);
      case 'move_file':         return this._moveFile(args);
      case 'delete_file':       return this._deleteFile(args);
      case 'create_directory':  return this._createDirectory(args);
      case 'list_directory':    return this._listDirectory(args);
      case 'find_files':        return this._listDirectory(args); // same impl
      case 'execute_bash':      return this._executeBash(args);
      case 'search_file_contents': return this._searchFileContents(args);
      case 'ask_question':      return this._askQuestion(args);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  // ── File operations ───────────────────────────────────────────────────────

  private async _readFile(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');
    const resolved = resolveEditPath(relPath, this.wsRoots);
    if (resolved.error) { return `Error: ${resolved.error}`; }

    const fileUri = vscode.Uri.file(resolved.resolvedPath!);
    let content: string;
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      content = doc.getText();
    } catch {
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        content = Buffer.from(bytes).toString('utf8');
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const lines = content.split('\n');
    const startLine = typeof args['start_line'] === 'number' ? args['start_line'] - 1 : 0;
    const endLine = typeof args['end_line'] === 'number' ? args['end_line'] - 1 : lines.length - 1;
    const slice = lines.slice(
      Math.max(0, startLine),
      Math.min(lines.length - 1, endLine) + 1
    );

    const actualStart = Math.max(1, startLine + 1);
    const header = `File: ${relPath} (lines ${actualStart}-${actualStart + slice.length - 1} of ${lines.length})`;
    return `${header}\n\`\`\`\n${slice.join('\n')}\n\`\`\``;
  }

  private async _writeFile(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');
    const content = String(args['content'] ?? '');

    const resolved = resolveEditPath(relPath, this.wsRoots);
    if (resolved.error) { return `Error: ${resolved.error}`; }

    const fileUri = vscode.Uri.file(resolved.resolvedPath!);

    // Check if file exists to tailor the approval message
    let fileExists = true;
    try { await vscode.workspace.fs.stat(fileUri); } catch { fileExists = false; }

    const action = fileExists ? 'overwrite file' : 'create file';
    const approved = await this.deps.requestApproval(
      'writeFile',
      { path: relPath, lines: content.split('\n').length },
      `The assistant wants to ${action}.`
    );
    if (!approved) { return `Cancelled by user.`; }

    try {
      const lfContent = content.replace(/\r\n/g, '\n');
      if (fileExists) {
        const wsEdit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        wsEdit.replace(fileUri, fullRange, lfContent);
        await vscode.workspace.applyEdit(wsEdit);
        await doc.save();
      } else {
        // Ensure parent directory exists
        const dir = path.dirname(resolved.resolvedPath!);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(lfContent, 'utf8'));
      }
      this.deps.postMessage({ type: 'status', text: `${fileExists ? 'Updated' : 'Created'}: ${relPath}` });
      return `Successfully ${fileExists ? 'updated' : 'created'} ${relPath}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _stringReplace(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');
    const oldStr = String(args['old_str'] ?? '');
    const newStr = String(args['new_str'] ?? '');

    if (!oldStr) { return 'Error: old_str must not be empty.'; }

    const resolved = resolveEditPath(relPath, this.wsRoots);
    if (resolved.error) { return `Error: ${resolved.error}`; }

    const fileUri = vscode.Uri.file(resolved.resolvedPath!);
    let originalContent: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      originalContent = Buffer.from(bytes).toString('utf8');
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Normalize line endings for matching
    const normalized = originalContent.replace(/\r\n/g, '\n');
    const normalizedOld = oldStr.replace(/\r\n/g, '\n');

    const firstIdx = normalized.indexOf(normalizedOld);
    if (firstIdx === -1) { return `Error: old_str not found in ${relPath}. Ensure it matches exactly (including whitespace).`; }

    const secondIdx = normalized.indexOf(normalizedOld, firstIdx + normalizedOld.length);
    if (secondIdx !== -1) { return `Error: old_str is ambiguous (found more than once) in ${relPath}. Provide more context to make it unique.`; }

    const approved = await this.deps.requestApproval(
      'applyEdit',
      { path: relPath },
      `string_replace`
    );
    if (!approved) { return 'Cancelled by user.'; }

    const newContent = normalized.slice(0, firstIdx) + newStr.replace(/\r\n/g, '\n') + normalized.slice(firstIdx + normalizedOld.length);
    try {
      const wsEdit = new vscode.WorkspaceEdit();
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      wsEdit.replace(fileUri, fullRange, newContent);
      await vscode.workspace.applyEdit(wsEdit);
      await doc.save();
      this.deps.postMessage({ type: 'status', text: `Edited: ${relPath}` });
      return `Successfully edited ${relPath}`;
    } catch (err) {
      return `Error applying edit: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _copyFile(args: Record<string, unknown>): Promise<string> {
    const srcRel = String(args['source'] ?? '');
    const dstRel = String(args['destination'] ?? '');

    const srcResolved = resolveEditPath(srcRel, this.wsRoots);
    const dstResolved = resolveEditPath(dstRel, this.wsRoots);
    if (srcResolved.error) { return `Error: source — ${srcResolved.error}`; }
    if (dstResolved.error) { return `Error: destination — ${dstResolved.error}`; }

    const approved = await this.deps.requestApproval(
      'copyFile',
      { source: srcRel, destination: dstRel },
      'The assistant wants to copy a file.'
    );
    if (!approved) { return 'Cancelled by user.'; }

    try {
      const dstDir = path.dirname(dstResolved.resolvedPath!);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dstDir));
      await vscode.workspace.fs.copy(
        vscode.Uri.file(srcResolved.resolvedPath!),
        vscode.Uri.file(dstResolved.resolvedPath!),
        { overwrite: false }
      );
      this.deps.postMessage({ type: 'status', text: `Copied: ${srcRel} → ${dstRel}` });
      return `Successfully copied ${srcRel} to ${dstRel}`;
    } catch (err) {
      return `Error copying file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _moveFile(args: Record<string, unknown>): Promise<string> {
    const srcRel = String(args['source'] ?? '');
    const dstRel = String(args['destination'] ?? '');

    const fromAbsolute = resolveMoveBlockPath(srcRel, this.wsRoots);
    const toAbsolute = resolveMoveBlockPath(dstRel, this.wsRoots);

    if (!fromAbsolute) { return `Error: source path "${srcRel}" is outside the workspace.`; }
    if (!toAbsolute) { return `Error: destination path "${dstRel}" is outside the workspace.`; }

    const approved = await this.deps.requestApproval(
      'moveFile',
      { from: srcRel, to: dstRel },
      'The assistant wants to move a file.'
    );
    if (!approved) { return 'Cancelled by user.'; }

    this.deps.postMessage({ type: 'status', text: `Moving: ${srcRel} → ${dstRel}` });
    const result = await moveFile(fromAbsolute, toAbsolute);
    if (result.success) {
      this.deps.postMessage({ type: 'status', text: `Moved: ${srcRel} → ${dstRel}` });
      return `Successfully moved ${srcRel} to ${dstRel}`;
    }
    return `Error moving file: ${result.error}`;
  }

  private async _deleteFile(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');

    const fileAbsolute = resolveDeleteBlockPath(relPath, this.wsRoots);
    if (!fileAbsolute) { return `Error: path "${relPath}" is outside the workspace.`; }

    const approved = await this.deps.requestApproval(
      'deleteFile',
      { path: relPath },
      'The assistant wants to delete a file (will be moved to trash).'
    );
    if (!approved) { return 'Cancelled by user.'; }

    this.deps.postMessage({ type: 'status', text: `Deleting: ${relPath}` });
    const result = await deleteFile(fileAbsolute);
    if (result.success) {
      this.deps.postMessage({ type: 'status', text: `Deleted (trashed): ${relPath}` });
      return `Successfully deleted ${relPath} (moved to trash)`;
    }
    return `Error deleting file: ${result.error}`;
  }

  private async _createDirectory(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');
    const resolved = resolveEditPath(relPath, this.wsRoots);
    if (resolved.error) { return `Error: ${resolved.error}`; }

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(resolved.resolvedPath!));
      this.deps.postMessage({ type: 'status', text: `Created directory: ${relPath}` });
      return `Successfully created directory ${relPath}`;
    } catch (err) {
      return `Error creating directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _listDirectory(args: Record<string, unknown>): Promise<string> {
    const glob = String(args['glob'] ?? '**/*');
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(glob, FILE_EXCLUDE_GLOB, 500);
    } catch (err) {
      return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
    }

    const paths = uris
      .map(u => {
        for (const root of this.wsRoots) {
          if (u.fsPath.startsWith(root + path.sep) || u.fsPath === root) {
            return u.fsPath.slice(root.length + 1).replace(/\\/g, '/');
          }
        }
        return u.fsPath.replace(/\\/g, '/');
      })
      .sort();

    if (paths.length === 0) { return `No files matched glob: ${glob}`; }
    return `${paths.length} file(s) matching "${glob}":\n${paths.join('\n')}`;
  }

  // ── Code execution ────────────────────────────────────────────────────────

  private async _executeBash(args: Record<string, unknown>): Promise<string> {
    const command = String(args['command'] ?? '');
    if (!command) { return 'Error: command must not be empty.'; }
    if (!this.wsRoot) { return 'Error: no workspace folder is open.'; }

    const approved = await this.deps.requestApproval(
      'runCommand',
      { command },
      'The assistant wants to run a terminal command.'
    );
    if (!approved) { return 'Cancelled by user.'; }

    this.deps.postMessage({ type: 'status', text: `Running: ${command}` });
    const result = await runCommand(command, this.wsRoot);

    const status = result.timedOut
      ? 'timed out (killed after 30s)'
      : `exit_code=${result.exitCode ?? 'null'}`;

    this.deps.postMessage({
      type: 'status',
      text: result.timedOut
        ? `Timed out: ${command}`
        : `Done (exit ${result.exitCode ?? '?'}): ${command}`
    });

    const parts: string[] = [`status: ${status}`];
    if (result.stdout) { parts.push(`stdout:\n${result.stdout}`); }
    if (result.stderr) { parts.push(`stderr:\n${result.stderr}`); }
    if (!result.stdout && !result.stderr) { parts.push('(no output)'); }
    return parts.join('\n');
  }

  // ── Search ────────────────────────────────────────────────────────────────

  private async _searchFileContents(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');
    const pattern = String(args['pattern'] ?? '');
    const caseSensitive = args['case_sensitive'] !== false;

    if (!pattern) { return 'Error: pattern must not be empty.'; }

    // Determine if searching a file or directory
    let absolutePath: string;
    const isGlob = /[*?{]/.test(relPath);
    if (isGlob || !relPath) {
      absolutePath = this.wsRoot;
    } else {
      const resolved = await this._resolveWithFallback(relPath);
      absolutePath = resolved ?? path.join(this.wsRoot, relPath);
    }

    const { lines, matchCount, error } = await searchFileWithRg(
      absolutePath,
      pattern,
      caseSensitive,
      undefined
    );

    if (error) {
      return `Search error: ${error}`;
    }
    if (matchCount === 0) {
      return `No matches found for pattern "${pattern}" in ${relPath || 'workspace'}`;
    }
    return `${matchCount} match(es) for "${pattern}" in ${relPath || 'workspace'}:\n${lines.join('\n')}`;
  }

  private async _resolveWithFallback(relPath: string): Promise<string | null> {
    const resolved = resolveEditPath(relPath, this.wsRoots);
    if (!resolved.error) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(resolved.resolvedPath!));
        return resolved.resolvedPath!;
      } catch { /* fall through */ }
    }
    // Glob fallback by basename
    const basename = path.basename(relPath);
    try {
      const uris = await vscode.workspace.findFiles(`**/${basename}`, FILE_EXCLUDE_GLOB, 5);
      if (uris.length === 1) { return uris[0].fsPath; }
    } catch { /* ignore */ }
    return null;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  private async _askQuestion(args: Record<string, unknown>): Promise<string> {
    const question = String(args['question'] ?? '');
    // Show the question as an approval card — the user's answer comes from the
    // free-text "Deny" path isn't meaningful here, so we use a VS Code input box.
    const answer = await vscode.window.showInputBox({
      prompt: question,
      ignoreFocusOut: true,
    });
    if (answer === undefined) {
      return 'User dismissed the question without answering.';
    }
    return answer;
  }
}
