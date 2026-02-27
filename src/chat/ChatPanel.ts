import * as vscode from 'vscode';
import { WebviewToExtension, ExtensionToWebview } from './messageProtocol';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { ChatMessage } from '../providers/IProvider';

export class ChatPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _abortController?: AbortController;
  private _history: ChatMessage[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

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

    this._history.push({ role: 'user', content: prompt });

    this._abortController = new AbortController();
    const provider = this._getProvider();

    try {
      await provider.stream(
        this._history,
        this._abortController.signal,
        (event) => {
          if (event.type === 'delta') {
            this._postMessage({ type: 'delta', content: event.content });
          } else if (event.type === 'done') {
            this._postMessage({ type: 'done' });
          } else if (event.type === 'error') {
            this._postMessage({ type: 'error', message: event.message });
          }
        }
      );
    } finally {
      this._abortController = undefined;
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
        // TODO: File attach flow (Phase 1)
        vscode.window.showInformationMessage('File attach not yet implemented.');
        break;
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
