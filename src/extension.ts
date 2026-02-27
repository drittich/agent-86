import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';
import { Session } from './config/ConfigManager';

// Quick-pick for sessions
async function showSessionQuickPick(chatPanel: ChatPanel): Promise<void> {
  const configManager = chatPanel.getConfigManager();
  const sessions = configManager.loadAllSessions();
  if (!sessions || sessions.length === 0) {
    vscode.window.showInformationMessage('No sessions found.');
    return;
  }

  const items: vscode.QuickPickItem[] = sessions.map((s: Session) => ({
    label: s.title,
    description: new Date(s.createdAt).toLocaleString()
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a session to restore',
    matchOnDescription: true
  });

  if (selected) {
    // Find the selected session
    const selectedSession = sessions.find((s: Session) => s.title === selected.label);
    if (selectedSession) {
      chatPanel.restoreSession(selectedSession);
      vscode.window.showInformationMessage(`Restored session: ${selectedSession.title}`);
    }
  }
}

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
    vscode.commands.registerCommand('agentic.selectSession', () => {
      showSessionQuickPick(chatPanel);
    }),
    vscode.window.registerWebviewViewProvider('agenticCoder.panel', chatPanel)
  );
}

export function deactivate(): void {
  // Nothing to clean up
}
