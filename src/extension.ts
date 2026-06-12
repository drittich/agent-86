import * as vscode from 'vscode';
import { ChatPanel } from './chat/ChatPanel';
import { FileTreeDataProvider, pickAndReadFilesFromTree, readActiveEditor } from './tools/FileTools';
import { initRgPath } from './tools/ChunkManager';

// File tree provider instance - shared across the extension
let fileTreeProvider: FileTreeDataProvider | undefined;
let fileTreeView: vscode.TreeView<any> | undefined;

function getFileTreeProvider(): FileTreeDataProvider | undefined {
  if (!fileTreeProvider) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    fileTreeProvider = new FileTreeDataProvider(workspaceFolders[0].uri);
  }
  return fileTreeProvider;
}

function initializeFileTreeView(context: vscode.ExtensionContext): void {
  const treeProvider = getFileTreeProvider();
  if (!treeProvider) {
    return; // No workspace open, skip tree view creation
  }
  fileTreeView = vscode.window.createTreeView('agent86FilePicker', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
  });

  // Listen for checkbox state changes
  context.subscriptions.push(
    fileTreeView.onDidChangeCheckboxState((e) => {
      const provider = getFileTreeProvider();
      if (!provider) return;
      for (const [item, state] of e.items) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          provider.toggleCheck(item.uri);
        } else {
          provider.toggleCheck(item.uri);
        }
      }
    })
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Agent 86');
  context.subscriptions.push(outputChannel);

  // Resolve rg path eagerly — it's a fast fs.existsSync check, not I/O bound
  const rgPathInfo = initRgPath(context.extensionPath);
  outputChannel.appendLine(`[init] rg path (${rgPathInfo})`);

  // Register file tree view in the sidebar (only if workspace is open)
  initializeFileTreeView(context);

  // ChatPanel is constructed lazily — only when the webview is first revealed.
  // Commands that need the panel will trigger reveal(), which constructs it.
  let chatPanel: ChatPanel | undefined;

  function getOrCreatePanel(): ChatPanel {
    if (!chatPanel) {
      chatPanel = new ChatPanel(context, outputChannel);
    }
    return chatPanel;
  }

  // Lazy WebviewViewProvider wrapper — defers ChatPanel construction to first reveal
  const lazyProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView, resolveContext, token) {
      getOrCreatePanel().resolveWebviewView(webviewView, resolveContext, token);
    },
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentic.openPanel', () => {
      getOrCreatePanel().reveal();
    }),
    vscode.commands.registerCommand('agent86.openPanel', () => {
      getOrCreatePanel().reveal();
    }),
    vscode.commands.registerCommand('agentic.newSession', () => {
      getOrCreatePanel().newSession();
    }),
    vscode.commands.registerCommand('agent86.newSession', () => {
      getOrCreatePanel().newSession();
    }),
    vscode.commands.registerCommand('agent86.openSettings', () => {
      getOrCreatePanel().openSettings();
    }),
    vscode.commands.registerCommand('agentic.attachFiles', async () => {
      const panel = getOrCreatePanel();
      panel.reveal();
      // Use the file tree picker instead of the old dialog
      const existing = panel.getAttachedFiles();
      const treeProvider = getFileTreeProvider();
      if (treeProvider && fileTreeView) {
        const updated = await pickAndReadFilesFromTree(existing, treeProvider, fileTreeView);
        panel.updateAttachedFiles(updated);
      } else {
        vscode.window.showWarningMessage('Please open a workspace folder to attach files.');
      }
    }),
    vscode.commands.registerCommand('agentic.selectSession', () => {
      getOrCreatePanel().showSessionHistory();
    }),
    vscode.commands.registerCommand('agent86.selectSession', () => {
      getOrCreatePanel().showSessionHistory();
    }),
    vscode.commands.registerCommand('agentic.attachActiveEditor', async () => {
      const panel = getOrCreatePanel();
      panel.reveal();
      const existing = panel.getAttachedFiles();
      const updated = await readActiveEditor(existing);
      if (updated) {
        panel.updateAttachedFiles(updated);
      }
    }),
    vscode.commands.registerCommand('agent86.reprobeToolSupport', () => {
      getOrCreatePanel().reprobeToolSupport();
    }),
    vscode.commands.registerCommand('agent86FilePicker.focus', () => {
      // The tree view is visible in the Explorer view under "File Picker"
      // This command is kept for potential future use
    }),
    vscode.window.registerWebviewViewProvider('agent86.panel', lazyProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up
}
