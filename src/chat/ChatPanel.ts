import * as vscode from 'vscode';
import { WebviewToExtension, ExtensionToWebview, AttachedFile } from './messageProtocol';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { ChatMessage } from '../providers/IProvider';
import { pickAndReadFiles } from '../tools/FileTools';
import { parseEditBlocks, resolveEditPath, validateFromText, applyEditBlock } from '../tools/editParser';

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

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this._diffProvider)
    );
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

      // After streaming completes, show diffs for any @@EDIT blocks
      if (fullResponse) {
        this._history.push({ role: 'assistant', content: fullResponse });
        await this._showEditDiffs(fullResponse);
      }
    } finally {
      this._abortController = undefined;
    }
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

      const fileUri = vscode.Uri.file(pathResult.resolvedPath);

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
    }
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
    }
  }

  private async _handleAttachFiles(): Promise<void> {
    const updated = await pickAndReadFiles(this._attachedFiles);
    this._attachedFiles = updated;
    this._postMessage({ type: 'attachments', files: updated });
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
