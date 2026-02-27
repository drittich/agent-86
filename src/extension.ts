import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';

export function activate(context: vscode.ExtensionContext): void {
  const chatPanel = new ChatPanel(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentic.openPanel', () => {
      chatPanel.reveal();
    }),
    vscode.commands.registerCommand('agentic.newSession', () => {
      chatPanel.newSession();
    }),
    vscode.commands.registerCommand('agentic.attachFiles', () => {
      chatPanel.attachFiles();
    }),
    vscode.window.registerWebviewViewProvider('agenticCoder.panel', chatPanel)
  );
}

export function deactivate(): void {
  // Nothing to clean up
}
