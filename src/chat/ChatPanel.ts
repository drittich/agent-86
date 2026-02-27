import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewToExtension, ExtensionToWebview } from './messageProtocol';

export class ChatPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

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
    this._postMessage({ type: 'status', text: 'New session started.' });
  }

  public attachFiles(): void {
    this._handleMessage({ type: 'attachFiles' });
  }

  private _handleMessage(message: WebviewToExtension): void {
    switch (message.type) {
      case 'send':
        // TODO: AgentRunner integration (Phase 0)
        this._postMessage({ type: 'status', text: 'Agent runner not yet implemented.' });
        break;
      case 'stop':
        // TODO: Abort controller (Phase 0)
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
