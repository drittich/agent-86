import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';
import { Session } from './config/ConfigManager';
import { FileTreeDataProvider, pickAndReadFilesFromTree, readActiveEditor } from './tools/FileTools';

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

// File tree provider instance - shared across the extension
let fileTreeProvider: FileTreeDataProvider | undefined;
let fileTreeView: vscode.TreeView<any> | undefined;

function getFileTreeProvider(): FileTreeDataProvider {
  if (!fileTreeProvider) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace folder open');
    }
    fileTreeProvider = new FileTreeDataProvider(workspaceFolders[0].uri);
  }
  return fileTreeProvider;
}

export function activate(context: vscode.ExtensionContext): void {
  const chatPanel = new ChatPanel(context);

  // Register file tree view in the sidebar
  const treeProvider = getFileTreeProvider();
  fileTreeView = vscode.window.createTreeView('agenticFilePicker', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
  });

  // Listen for checkbox state changes
  context.subscriptions.push(
    fileTreeView.onDidChangeCheckboxState((e) => {
      const provider = getFileTreeProvider();
      for (const [item, state] of e.items) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          provider.toggleCheck(item.uri);
        } else {
          provider.toggleCheck(item.uri);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentic.openPanel', () => {
      chatPanel.reveal();
    }),
    vscode.commands.registerCommand('agentic.newSession', () => {
      chatPanel.newSession();
    }),
    vscode.commands.registerCommand('agentic.attachFiles', async () => {
      chatPanel.reveal();
      // Use the file tree picker instead of the old dialog
      const existing = chatPanel.getAttachedFiles();
      const updated = await pickAndReadFilesFromTree(existing, treeProvider, fileTreeView);
      chatPanel.updateAttachedFiles(updated);
    }),
    vscode.commands.registerCommand('agentic.selectSession', () => {
      showSessionQuickPick(chatPanel);
    }),
    vscode.commands.registerCommand('agentic.attachActiveEditor', async () => {
      chatPanel.reveal();
      const existing = chatPanel.getAttachedFiles();
      const updated = await readActiveEditor(existing);
      if (updated) {
        chatPanel.updateAttachedFiles(updated);
      }
    }),
    vscode.commands.registerCommand('agenticFilePicker.focus', () => {
      // The tree view is visible in the Explorer view under "File Picker"
      // This command is kept for potential future use
    }),
    vscode.window.registerWebviewViewProvider('agenticCoder.panel', chatPanel)
  );
}

export function deactivate(): void {
  // Nothing to clean up
}
