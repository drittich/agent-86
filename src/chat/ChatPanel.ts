import * as vscode from 'vscode';
import { WebviewToExtension, ExtensionToWebview, AttachedFile } from './messageProtocol';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { ChatMessage } from '../providers/IProvider';
import { pickAndReadFiles } from '../tools/FileTools';
import { parseEditBlocks, resolveEditPath, validateFromText, applyEditBlock } from '../tools/editParser';
import { parseRunBlocks, runCommand, formatRunResult } from '../tools/TerminalTool';
import { parseMoveBlocks, resolveMoveBlockPath, moveFile, formatMoveResult } from '../tools/MoveFileTool';
import { parseDeleteBlocks, resolveDeleteBlockPath, deleteFile, formatDeleteResult } from '../tools/DeleteFileTool';
import { ConfigManager, Session } from '../config/ConfigManager';

const DIFF_SCHEME = 'agentic-diff';

/** In-memory content provider for diff previews. */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private _contents = new Map<string, string>();

  set(key: string, content: string): void {
    this._contents.set(key, content);
  }

  delete(key: string): void {
    this._contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.path) ?? '';
  }
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _abortController?: AbortController;
  private _history: ChatMessage[] = [];
  private _attachedFiles: AttachedFile[] = [];
  private readonly _diffProvider = new DiffContentProvider();
  /** Pending approval resolvers keyed by approvalId. */
  private readonly _approvalResolvers = new Map<string, (approved: boolean) => void>();
  private _approvalCounter = 0;
  private readonly _configManager: ConfigManager;
  private _currentSession: Session;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this._diffProvider)
    );
    this._configManager = new ConfigManager(context);
    // Restore last session, or start a fresh one
    const restored = this._configManager.loadLastSession();
    if (restored) {
      this._currentSession = restored;
      this._history = restored.messages;
      this._attachedFiles = restored.attachments;
    } else {
      this._currentSession = this._configManager.createSession();
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtension) => {
      this._handleMessage(message);
    });

    // Restore UI state from the current session once the webview is ready
    this._restoreSessionUi();
  }

  public reveal(): void {
    if (this._view) {
      this._view.show(true);
    } else {
      vscode.commands.executeCommand('agenticCoder.panel.focus');
    }
  }

  public newSession(): void {
    this._abortController?.abort();
    this._abortController = undefined;
    this._history = [];
    this._attachedFiles = [];
    this._currentSession = this._configManager.createSession();
    this._postMessage({ type: 'status', text: 'New session started.' });
  }

  public attachFiles(): void {
    this._handleMessage({ type: 'attachFiles' });
  }

  private _getProvider(): OpenAIProvider {
    const cfg = vscode.workspace.getConfiguration('agentCoder');
    const baseUrl = cfg.get<string>('baseUrl') ?? 'http://127.0.0.1:8083/v1';
    const model = cfg.get<string>('model') ?? 'gpt-3.5-turbo';
    const apiKey = cfg.get<string>('apiKey') ?? 'local';
    return new OpenAIProvider(baseUrl, model, apiKey);
  }

  private async _handleSend(prompt: string): Promise<void> {
    if (this._abortController) {
      // Already generating — ignore duplicate sends
      return;
    }

    // Build user message, prepending attached file contents on first turn
    let userContent = prompt;
    if (this._attachedFiles.length > 0 && this._history.length === 0) {
      const fileBlocks = this._attachedFiles.map(f =>
        `<file path="${f.relativePath}" language="${f.languageId}">\n${f.content}\n</file>`
      ).join('\n\n');
      userContent = `${fileBlocks}\n\n${prompt}`;
    }

    this._history.push({ role: 'user', content: userContent });

    this._abortController = new AbortController();
    const provider = this._getProvider();

    let fullResponse = '';

    try {
      await provider.stream(
        this._history,
        this._abortController.signal,
        (event) => {
          if (event.type === 'delta') {
            fullResponse += event.content;
            this._postMessage({ type: 'delta', content: event.content });
          } else if (event.type === 'done') {
            this._postMessage({ type: 'done' });
          } else if (event.type === 'error') {
            this._postMessage({ type: 'error', message: event.message });
          }
        }
      );

      // After streaming completes, process @@EDIT and @@RUN blocks
      if (fullResponse) {
        this._history.push({ role: 'assistant', content: fullResponse });
        await this._showEditDiffs(fullResponse);
        await this._processRunBlocks(fullResponse);
        await this._processMoveBlocks(fullResponse);
        await this._processDeleteBlocks(fullResponse);
      }
    } finally {
      this._abortController = undefined;
    }

    // Persist session after each completed turn
    this._saveCurrentSession();
  }

  /**
   * Parse @@EDIT blocks from the assistant response and open a VS Code diff
   * tab for each one so the user can review changes before applying.
   */
  private async _showEditDiffs(assistantText: string): Promise<void> {
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    if (wsRoots.length === 0) {
      return;
    }

    const { blocks, warnings } = parseEditBlocks(assistantText);

    for (const warning of warnings) {
      this._postMessage({ type: 'status', text: `Edit parse warning: ${warning}` });
    }

    for (const block of blocks) {
      const pathResult = resolveEditPath(block.path, wsRoots);
      if (pathResult.error) {
        this._postMessage({ type: 'status', text: `Edit error: ${pathResult.error}` });
        continue;
      }

      const fileUri = vscode.Uri.file(pathResult.resolvedPath!);

      // Read current file content (may not exist yet for new-file blocks)
      let originalContent = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        originalContent = Buffer.from(bytes).toString('utf8');
      } catch {
        // File doesn't exist — treat as empty (new file)
      }

      // Validate FROM text
      const fromError = validateFromText(block, originalContent);
      if (fromError) {
        this._postMessage({ type: 'status', text: `Edit error: ${fromError}` });
        continue;
      }

      // Compute the new content
      const newContent = applyEditBlock(block, originalContent);

      // Register both sides with the in-memory provider
      const oldKey = `${block.path}?side=old`;
      const newKey = `${block.path}?side=new`;
      this._diffProvider.set(oldKey, originalContent);
      this._diffProvider.set(newKey, newContent);

      const oldUri = vscode.Uri.parse(`${DIFF_SCHEME}:${oldKey}`);
      const newUri = vscode.Uri.parse(`${DIFF_SCHEME}:${newKey}`);
      const title = `Review: ${block.path}`;

      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, {
        preview: true,
      });

      // Ask the user whether to apply
      const approved = await this._requestApproval('applyEdit', { path: block.path });

      // Clean up diff provider entries
      this._diffProvider.delete(oldKey);
      this._diffProvider.delete(newKey);

      if (!approved) {
        this._postMessage({ type: 'status', text: `Edit cancelled: ${block.path}` });
        continue;
      }

      // Write the file
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(fileUri, encoder.encode(newContent));
      this._postMessage({ type: 'status', text: `Applied: ${block.path}` });
    }
  }

  /**
   * Parse @@RUN blocks from the assistant response, request approval for each,
   * execute approved commands, and append a summary back into the conversation
   * so the model can see the output.
   */
  private async _processRunBlocks(assistantText: string): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    if (wsRoots.length === 0) {
      return;
    }

    const cwd = wsRoots[0].uri.fsPath;
    const blocks = parseRunBlocks(assistantText);
    if (blocks.length === 0) {
      return;
    }

    const resultLines: string[] = [];

    for (const block of blocks) {
      const approved = await this._requestApproval(
        'runCommand',
        { command: block.command },
        'The assistant wants to run a terminal command.'
      );

      if (!approved) {
        this._postMessage({ type: 'status', text: `Command cancelled: ${block.command}` });
        resultLines.push(`@@RUN_RESULT command: ${block.command}\nstatus: cancelled by user`);
        continue;
      }

      this._postMessage({ type: 'status', text: `Running: ${block.command}` });
      const result = await runCommand(block.command, cwd);
      const summary = formatRunResult(result);
      resultLines.push(summary);

      const statusText = result.timedOut
        ? `Timed out: ${block.command}`
        : `Done (exit ${result.exitCode ?? '?'}): ${block.command}`;
      this._postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this._history.push({ role: 'user', content: feedbackContent });
    this._saveCurrentSession();
  }

  /**
   * Parse @@MOVE blocks from the assistant response, request approval for each,
   * execute approved moves, and append a summary back into the conversation
   * so the model can see the result.
   */
  private async _processMoveBlocks(assistantText: string): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    if (wsRoots.length === 0) {
      return;
    }

    const wsRootPaths = wsRoots.map(f => f.uri.fsPath);
    const blocks = parseMoveBlocks(assistantText);
    if (blocks.length === 0) {
      return;
    }

    const resultLines: string[] = [];

    for (const block of blocks) {
      const fromAbsolute = resolveMoveBlockPath(block.from, wsRootPaths);
      const toAbsolute = resolveMoveBlockPath(block.to, wsRootPaths);

      if (!fromAbsolute) {
        const msg = `Move blocked: source path "${block.from}" is outside the workspace.`;
        this._postMessage({ type: 'status', text: msg });
        resultLines.push(`@@MOVE_RESULT\nfrom: ${block.from}\nto: ${block.to}\nstatus: failed\nerror: ${msg}`);
        continue;
      }

      if (!toAbsolute) {
        const msg = `Move blocked: destination path "${block.to}" is outside the workspace.`;
        this._postMessage({ type: 'status', text: msg });
        resultLines.push(`@@MOVE_RESULT\nfrom: ${block.from}\nto: ${block.to}\nstatus: failed\nerror: ${msg}`);
        continue;
      }

      const approved = await this._requestApproval(
        'moveFile',
        { from: block.from, to: block.to },
        'The assistant wants to move a file.'
      );

      if (!approved) {
        this._postMessage({ type: 'status', text: `Move cancelled: ${block.from} → ${block.to}` });
        resultLines.push(`@@MOVE_RESULT\nfrom: ${block.from}\nto: ${block.to}\nstatus: cancelled by user`);
        continue;
      }

      this._postMessage({ type: 'status', text: `Moving: ${block.from} → ${block.to}` });
      const result = await moveFile(fromAbsolute, toAbsolute);
      const summary = formatMoveResult(result);
      resultLines.push(summary);

      const statusText = result.success
        ? `Moved: ${block.from} → ${block.to}`
        : `Move failed: ${result.error}`;
      this._postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this._history.push({ role: 'user', content: feedbackContent });
    this._saveCurrentSession();
  }

  /**
   * Parse @@DELETE blocks from the assistant response, request approval for each,
   * execute approved deletions (to trash), and append a summary back into the
   * conversation so the model can see the result.
   */
  private async _processDeleteBlocks(assistantText: string): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    if (wsRoots.length === 0) {
      return;
    }

    const wsRootPaths = wsRoots.map(f => f.uri.fsPath);
    const blocks = parseDeleteBlocks(assistantText);
    if (blocks.length === 0) {
      return;
    }

    const resultLines: string[] = [];

    for (const block of blocks) {
      const fileAbsolute = resolveDeleteBlockPath(block.filePath, wsRootPaths);

      if (!fileAbsolute) {
        const msg = `Delete blocked: path "${block.filePath}" is outside the workspace.`;
        this._postMessage({ type: 'status', text: msg });
        resultLines.push(`@@DELETE_RESULT\npath: ${block.filePath}\nstatus: failed\nerror: ${msg}`);
        continue;
      }

      const approved = await this._requestApproval(
        'deleteFile',
        { path: block.filePath },
        'The assistant wants to delete a file (will be moved to trash).'
      );

      if (!approved) {
        this._postMessage({ type: 'status', text: `Delete cancelled: ${block.filePath}` });
        resultLines.push(`@@DELETE_RESULT\npath: ${block.filePath}\nstatus: cancelled by user`);
        continue;
      }

      this._postMessage({ type: 'status', text: `Deleting: ${block.filePath}` });
      const result = await deleteFile(fileAbsolute);
      const summary = formatDeleteResult(result);
      resultLines.push(summary);

      const statusText = result.success
        ? `Deleted (trashed): ${block.filePath}`
        : `Delete failed: ${result.error}`;
      this._postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this._history.push({ role: 'user', content: feedbackContent });
    this._saveCurrentSession();
  }

  /**
   * Send an `approval/request` to the webview and wait for the user's
   * `approval/response`. Returns `true` if approved, `false` if cancelled.
   */
  private _requestApproval(action: string, payload: unknown, reason = ''): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const approvalId = `approval-${++this._approvalCounter}`;
      this._approvalResolvers.set(approvalId, resolve);
      this._postMessage({ type: 'approval/request', approvalId, action, payload, reason });
    });
  }

  private _handleMessage(message: WebviewToExtension): void {
    switch (message.type) {
      case 'send':
        this._handleSend(message.prompt).catch((err) => {
          this._postMessage({ type: 'error', message: String(err) });
          this._abortController = undefined;
        });
        break;
      case 'stop':
        this._abortController?.abort();
        this._abortController = undefined;
        this._postMessage({ type: 'done' });
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'attachFiles':
        this._handleAttachFiles().catch((err) => {
          this._postMessage({ type: 'error', message: String(err) });
        });
        break;
      case 'approval/response': {
        const resolver = this._approvalResolvers.get(message.approvalId);
        if (resolver) {
          this._approvalResolvers.delete(message.approvalId);
          resolver(message.approved);
        }
        break;
      }
    }
  }

  private async _handleAttachFiles(): Promise<void> {
    const updated = await pickAndReadFiles(this._attachedFiles);
    this._attachedFiles = updated;
    this._postMessage({ type: 'attachments', files: updated });
    this._saveCurrentSession();
  }

  private _saveCurrentSession(): void {
    this._currentSession = {
      ...this._currentSession,
      messages: this._history,
      attachments: this._attachedFiles,
    };
    this._configManager.saveSession(this._currentSession);
  }

  /**
   * Push the current session's conversation history and attachments back into
   * the webview so the UI reflects a restored session after a VS Code restart.
   */
  private _restoreSessionUi(): void {
    if (this._attachedFiles.length > 0) {
      this._postMessage({ type: 'attachments', files: this._attachedFiles });
    }
    if (this._history.length > 0) {
      // Replay the conversation as a series of delta messages followed by done,
      // so the existing output area rendering logic is reused without changes.
      for (const msg of this._history) {
        const prefix = msg.role === 'user' ? '\n\n[You]\n' : '\n\n[Assistant]\n';
        this._postMessage({ type: 'delta', content: prefix + msg.content });
      }
      this._postMessage({ type: 'done' });
      this._postMessage({ type: 'status', text: 'Session restored.' });
    }
  }

  private _postMessage(message: ExtensionToWebview): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentic Coder</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
