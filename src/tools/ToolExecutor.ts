import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ToolCallEvent } from '../providers/IProvider';
import { runWebSearch, formatWebSearchOutput, HttpGetFn, SearchIntent } from './webSearch/index';
import { runCommand } from './TerminalTool';
import { resolveMoveBlockPath, moveFile } from './MoveFileTool';
import { resolveDeleteBlockPath, deleteFile } from './DeleteFileTool';
import { searchFileWithRg } from './ChunkManager';
import { resolveEditPath } from './editParser';
import { FILE_EXCLUDE_GLOB } from './FileTools';
import { GitIgnoreFilter } from '../utils/GitIgnoreFilter';

export interface ToolExecutorDeps {
  log: vscode.OutputChannel;
  postMessage: (message: unknown) => void;
  requestApproval: (action: string, payload: unknown, reason?: string) => Promise<boolean>;
  requestQuestion: (question: string) => Promise<string>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
}

// ── Task types ─────────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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
  private readonly gitIgnoreFilter: GitIgnoreFilter;

  constructor(
    private readonly deps: ToolExecutorDeps,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ) {
    this.wsRoots = workspaceFolders.map(f => f.uri.fsPath);
    this.wsRoot = this.wsRoots[0] ?? '';
    this.gitIgnoreFilter = new GitIgnoreFilter(this.wsRoots);
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
      case 'read_file':            return this._readFile(args);
      case 'write_file':           return this._writeFile(args);
      case 'string_replace':       return this._stringReplace(args);
      case 'copy_file':            return this._copyFile(args);
      case 'move_file':            return this._moveFile(args);
      case 'delete_file':          return this._deleteFile(args);
      case 'create_directory':     return this._createDirectory(args);
      case 'list_directory':       return this._listDirectory(args);
      case 'find_files':           return this._listDirectory(args); // same impl
      case 'execute_bash':         return this._executeBash(args);
      case 'search_file_contents': return this._searchFileContents(args);
      case 'get_diagnostics':      return this._getDiagnostics(args);
      case 'web_search':           return this._webSearch(args);
      case 'fetch_url':            return this._fetchUrl(args);
      case 'create_task':          return this._createTask(args);
      case 'list_tasks':           return this._listTasks();
      case 'update_task':          return this._updateTask(args);
      case 'delete_task':          return this._deleteTask(args);
      case 'ask_question':         return this._askQuestion(args);
      case 'git_status':           return this._git(['status', '--short', '--branch']);
      case 'git_diff':             return this._gitDiff(args);
      case 'git_log':              return this._gitLog(args);
      case 'git_add':              return this._gitAdd(args);
      case 'git_commit':           return this._gitCommit(args);
      case 'git_push':             return this._gitPush(args);
      case 'git_pull':             return this._gitPull(args);
      case 'git_branch':           return this._gitBranch(args);
      case 'git_stash':            return this._gitStash(args);
      case 'git_reset':            return this._gitReset(args);
      case 'git_pr':               return this._gitPr(args);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  // ── File operations ───────────────────────────────────────────────────────

  private async _readFile(args: Record<string, unknown>): Promise<string> {
    const relPath = String(args['path'] ?? '');
    const resolved = resolveEditPath(relPath, this.wsRoots);
    if (resolved.error) { return `Error: ${resolved.error}`; }

    if (this.gitIgnoreFilter.isIgnored(relPath)) {
      return `Error: "${relPath}" is excluded by .gitignore.`;
    }

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
      .filter(p => !this.gitIgnoreFilter.isIgnored(p))
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
    const resultBody = `${matchCount} match(es) for "${pattern}" in ${relPath || 'workspace'}:\n${lines.join('\n')}`;
    // Remind the model that context lines include formatting markers not in the file.
    const isFilePath = !isGlob && !!relPath;
    const editWarning = isFilePath
      ? '\n\nNote: lines above include ">" markers and "N:" prefixes for display only — they are not in the file. Use read_file on the relevant line range to get exact content before calling string_replace.'
      : '';
    return resultBody + editWarning;
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
      const nonIgnored = uris.filter(u => {
        for (const root of this.wsRoots) {
          if (u.fsPath.startsWith(root + path.sep)) {
            const rel = u.fsPath.slice(root.length + 1).replace(/\\/g, '/');
            return !this.gitIgnoreFilter.isIgnored(rel);
          }
        }
        return true;
      });
      if (nonIgnored.length === 1) { return nonIgnored[0].fsPath; }
    } catch { /* ignore */ }
    return null;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  private _getDiagnostics(args: Record<string, unknown>): string {
    const relPath = args['path'] ? String(args['path']) : undefined;

    const severityLabel = (s: vscode.DiagnosticSeverity): string => {
      switch (s) {
        case vscode.DiagnosticSeverity.Error:       return 'error';
        case vscode.DiagnosticSeverity.Warning:     return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'info';
        case vscode.DiagnosticSeverity.Hint:        return 'hint';
        default: return 'unknown';
      }
    };

    let allDiagnostics: [vscode.Uri, readonly vscode.Diagnostic[]][];

    if (relPath) {
      // Filter to a specific file
      const absPath = path.isAbsolute(relPath)
        ? relPath
        : path.join(this.wsRoot, relPath);
      const uri = vscode.Uri.file(absPath);
      const diags = vscode.languages.getDiagnostics(uri);
      allDiagnostics = diags.length > 0 ? [[uri, diags]] : [];
    } else {
      allDiagnostics = vscode.languages.getDiagnostics();
    }

    if (allDiagnostics.length === 0) {
      return relPath
        ? `No diagnostics for ${relPath}`
        : 'No diagnostics in the workspace.';
    }

    const lines: string[] = [];
    let total = 0;

    for (const [uri, diags] of allDiagnostics) {
      if (diags.length === 0) { continue; }

      // Make path workspace-relative
      let filePath = uri.fsPath;
      for (const root of this.wsRoots) {
        if (filePath.startsWith(root + path.sep) || filePath === root) {
          filePath = filePath.slice(root.length + 1).replace(/\\/g, '/');
          break;
        }
      }

      lines.push(`\n${filePath}:`);
      for (const d of diags) {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        lines.push(`  [${severityLabel(d.severity)}] line ${line}:${col} — ${d.message}`);
        total++;
      }
    }

    return `${total} diagnostic(s) found:${lines.join('\n')}`;
  }

  // ── Web ───────────────────────────────────────────────────────────────────

  private async _webSearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args['query'] ?? '').trim();
    if (!query) { return 'Error: query must not be empty.'; }

    const VALID_INTENTS: SearchIntent[] = ['reference', 'implementation', 'debugging', 'comparison', 'general'];
    const intentArg = String(args['intent'] ?? '');
    const intent = VALID_INTENTS.includes(intentArg as SearchIntent) ? intentArg as SearchIntent : undefined;
    const max_results = Math.min(20, Math.max(1, Number(args['max_results'] ?? 8)));

    const httpGet: HttpGetFn = (url, headers) => this._httpGet(url, headers);

    try {
      const output = await runWebSearch({ query, intent, max_results }, httpGet);
      return formatWebSearchOutput(query, output);
    } catch (err) {
      return `Error performing web search: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _fetchUrl(args: Record<string, unknown>): Promise<string> {
    const url = String(args['url'] ?? '');
    if (!url) { return 'Error: url must not be empty.'; }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      return `Error: invalid URL "${url}"`;
    }

    const MAX_BYTES = 32 * 1024;

    try {
      const body = await this._httpGet(url, {
        'User-Agent': 'Mozilla/5.0 (compatible; agent-86/1.0)',
        'Accept': 'text/html,text/plain,application/xhtml+xml',
      });

      // Strip HTML tags for cleaner output
      const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (text.length > MAX_BYTES) {
        return text.slice(0, MAX_BYTES) + `\n\n... [content truncated at ${MAX_BYTES} bytes]`;
      }
      return text || '(empty response)';
    } catch (err) {
      return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Perform an HTTP(S) GET and return the response body as a string. Follows up to 3 redirects. */
  private _httpGet(url: string, headers: Record<string, string>, redirectsLeft = 3): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const req = mod.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers, port: parsed.port || undefined },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) { return reject(new Error('Too many redirects')); }
            const next = new URL(res.headers.location, url).toString();
            resolve(this._httpGet(next, headers, redirectsLeft - 1));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        }
      );
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
    });
  }

  // ── Task management ───────────────────────────────────────────────────────

  private _tasksFilePath(): string {
    return path.join(this.wsRoot, '.agent86', 'tasks.json');
  }

  private _loadTasks(): Task[] {
    try {
      const raw = fs.readFileSync(this._tasksFilePath(), 'utf8');
      return JSON.parse(raw) as Task[];
    } catch {
      return [];
    }
  }

  private _saveTasks(tasks: Task[]): void {
    const dir = path.dirname(this._tasksFilePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._tasksFilePath(), JSON.stringify(tasks, null, 2), 'utf8');
  }

  private _generateTaskId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  private async _createTask(args: Record<string, unknown>): Promise<string> {
    if (!this.wsRoot) { return 'Error: no workspace folder is open.'; }

    const rawTasks = args['tasks'];
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return 'Error: tasks must be a non-empty array.';
    }

    const tasks = this._loadTasks();
    const now = new Date().toISOString();
    const created: Task[] = [];

    for (const t of rawTasks) {
      const title = String((t as Record<string, unknown>)['title'] ?? '').trim();
      if (!title) { continue; }
      const task: Task = {
        id: this._generateTaskId(),
        title,
        description: (t as Record<string, unknown>)['description'] ? String((t as Record<string, unknown>)['description']) : undefined,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task);
      created.push(task);
    }

    if (created.length === 0) { return 'Error: no valid tasks provided.'; }
    this._saveTasks(tasks);

    return `Created ${created.length} task(s):\n${created.map(t => `  [${t.id}] ${t.title}`).join('\n')}`;
  }

  private _listTasks(): string {
    if (!this.wsRoot) { return 'Error: no workspace folder is open.'; }

    const tasks = this._loadTasks();
    if (tasks.length === 0) { return 'No tasks.'; }

    const groups: Record<TaskStatus, Task[]> = { pending: [], in_progress: [], completed: [] };
    for (const t of tasks) {
      (groups[t.status] ?? groups['pending']).push(t);
    }

    const lines: string[] = [`${tasks.length} task(s):`];
    const order: TaskStatus[] = ['in_progress', 'pending', 'completed'];
    for (const status of order) {
      const group = groups[status];
      if (group.length === 0) { continue; }
      const label = status === 'in_progress' ? 'In Progress' : status.charAt(0).toUpperCase() + status.slice(1);
      lines.push(`\n${label}:`);
      for (const t of group) {
        lines.push(`  [${t.id}] ${t.title}${t.description ? ` — ${t.description}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  private _updateTask(args: Record<string, unknown>): string {
    if (!this.wsRoot) { return 'Error: no workspace folder is open.'; }

    const id = String(args['id'] ?? '');
    const status = String(args['status'] ?? '') as TaskStatus;

    if (!id) { return 'Error: id is required.'; }
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return `Error: status must be one of pending, in_progress, completed.`;
    }

    const tasks = this._loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) { return `Error: task "${id}" not found.`; }

    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (status === 'completed') { task.completedAt = task.updatedAt; }
    this._saveTasks(tasks);

    return `Updated task [${id}] "${task.title}" → ${status}`;
  }

  private _deleteTask(args: Record<string, unknown>): string {
    if (!this.wsRoot) { return 'Error: no workspace folder is open.'; }

    const id = String(args['id'] ?? '');
    if (!id) { return 'Error: id is required.'; }

    const tasks = this._loadTasks();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) { return `Error: task "${id}" not found.`; }

    const [removed] = tasks.splice(idx, 1);
    this._saveTasks(tasks);

    return `Deleted task [${id}] "${removed.title}"`;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  private async _askQuestion(args: Record<string, unknown>): Promise<string> {
    const question = String(args['question'] ?? '');
    return this.deps.requestQuestion(question);
  }

  // ── Git ───────────────────────────────────────────────────────────────────

  /** Run a git command in wsRoot and return combined stdout+stderr. */
  private _git(gitArgs: string[], timeout = 15_000): Promise<string> {
    return new Promise((resolve) => {
      if (!this.wsRoot) { resolve('Error: no workspace folder is open.'); return; }

      execFile('git', gitArgs, { cwd: this.wsRoot, timeout, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && !out) {
          resolve(`Error: ${err.message}`);
        } else {
          resolve(out || '(no output)');
        }
      });
    });
  }

  private async _gitDiff(args: Record<string, unknown>): Promise<string> {
    const extra = String(args['args'] ?? '').trim();
    const gitArgs = extra ? ['diff', ...extra.split(/\s+/)] : ['diff'];
    return this._git(gitArgs);
  }

  private async _gitLog(args: Record<string, unknown>): Promise<string> {
    const maxCount = Math.max(1, Math.min(100, Number(args['max_count'] ?? 10)));
    const extra = String(args['args'] ?? '').trim();
    const gitArgs = ['log', `--max-count=${maxCount}`, '--pretty=format:%h %as %s'];
    if (extra) { gitArgs.push(...extra.split(/\s+/)); }
    return this._git(gitArgs);
  }

  private async _gitAdd(args: Record<string, unknown>): Promise<string> {
    const paths = Array.isArray(args['paths']) ? (args['paths'] as unknown[]).map(String) : [];
    if (paths.length === 0) { return 'Error: paths must be a non-empty array.'; }

    const approved = await this.deps.requestApproval(
      'gitAdd',
      { paths },
      `The assistant wants to stage: ${paths.join(', ')}`
    );
    if (!approved) { return 'Cancelled by user.'; }

    return this._git(['add', '--', ...paths]);
  }

  private async _gitCommit(args: Record<string, unknown>): Promise<string> {
    const message = String(args['message'] ?? '').trim();
    const body = args['body'] ? String(args['body']).trim() : '';

    if (!message) { return 'Error: message must not be empty.'; }

    // Show staged diff for context
    const staged = await this._git(['diff', '--staged', '--stat']);

    const approved = await this.deps.requestApproval(
      'gitCommit',
      { message, body: body || undefined, staged: staged || '(nothing staged)' },
      'The assistant wants to create a commit.'
    );
    if (!approved) { return 'Cancelled by user.'; }

    const fullMessage = body ? `${message}\n\n${body}` : message;
    return this._git(['commit', '-m', fullMessage]);
  }

  private async _gitPush(args: Record<string, unknown>): Promise<string> {
    const extra = String(args['args'] ?? '').trim();
    const gitArgs = extra ? ['push', ...extra.split(/\s+/)] : ['push'];

    const approved = await this.deps.requestApproval(
      'gitPush',
      { args: extra || undefined },
      'The assistant wants to push to the remote.'
    );
    if (!approved) { return 'Cancelled by user.'; }

    return this._git(gitArgs, 30_000);
  }

  private async _gitPull(args: Record<string, unknown>): Promise<string> {
    const extra = String(args['args'] ?? '').trim();
    const gitArgs = extra ? ['pull', ...extra.split(/\s+/)] : ['pull'];

    const approved = await this.deps.requestApproval(
      'gitPull',
      { args: extra || undefined },
      'The assistant wants to pull from the remote.'
    );
    if (!approved) { return 'Cancelled by user.'; }

    return this._git(gitArgs, 30_000);
  }

  private async _gitBranch(args: Record<string, unknown>): Promise<string> {
    const extra = String(args['args'] ?? '').trim();
    // Destructive operations (delete) need approval
    if (extra && /^-[dD]/.test(extra)) {
      const approved = await this.deps.requestApproval(
        'gitBranch',
        { args: extra },
        'The assistant wants to delete a branch.'
      );
      if (!approved) { return 'Cancelled by user.'; }
    }
    const gitArgs = extra ? ['branch', ...extra.split(/\s+/)] : ['branch', '-a'];
    return this._git(gitArgs);
  }

  private async _gitStash(args: Record<string, unknown>): Promise<string> {
    const sub = String(args['args'] ?? 'push').trim().split(/\s+/)[0];

    if (sub !== 'list') {
      const approved = await this.deps.requestApproval(
        'gitStash',
        { args: args['args'] ?? 'push' },
        `The assistant wants to run git stash ${args['args'] ?? 'push'}.`
      );
      if (!approved) { return 'Cancelled by user.'; }
    }

    const extra = String(args['args'] ?? 'push').trim();
    return this._git(['stash', ...extra.split(/\s+/)]);
  }

  private async _gitReset(args: Record<string, unknown>): Promise<string> {
    const resetArgs = String(args['args'] ?? '').trim();
    if (!resetArgs) { return 'Error: args is required for git_reset.'; }

    const isHard = /--hard/.test(resetArgs);
    const needsApproval = isHard || /HEAD/.test(resetArgs);

    if (needsApproval) {
      const approved = await this.deps.requestApproval(
        'gitReset',
        { args: resetArgs },
        `The assistant wants to run: git reset ${resetArgs}`
      );
      if (!approved) { return 'Cancelled by user.'; }
    }

    return this._git(['reset', ...resetArgs.split(/\s+/)]);
  }

  private async _gitPr(args: Record<string, unknown>): Promise<string> {
    const prArgs = String(args['args'] ?? '').trim();
    if (!prArgs) { return 'Error: args is required for git_pr.'; }

    const approved = await this.deps.requestApproval(
      'gitPr',
      { args: prArgs },
      `The assistant wants to run: gh pr ${prArgs}`
    );
    if (!approved) { return 'Cancelled by user.'; }

    return new Promise((resolve) => {
      execFile('gh', ['pr', ...prArgs.split(/\s+/)], { cwd: this.wsRoot, timeout: 30_000, maxBuffer: 1024 * 256 }, (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && !out) {
          resolve(`Error: ${err.message}`);
        } else {
          resolve(out || '(no output)');
        }
      });
    });
  }
}
