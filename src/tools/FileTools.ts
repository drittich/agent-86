import * as vscode from 'vscode';
import * as path from 'path';
import { AttachedFile } from '../chat/messageProtocol';

const FILE_CAP_BYTES = 300 * 1024;   // 300 KB per file
const TOTAL_CAP_BYTES = 1.5 * 1024 * 1024; // 1.5 MB total

// File tree picker using TreeView with checkboxes
export class FileTreeItem extends vscode.TreeItem {
  children?: FileTreeItem[];
  isFile: boolean;
  uri: vscode.Uri;

  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    isDirectory: boolean,
    public checked: boolean = false
  ) {
    super(
      resourceUri,
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.isFile = !isDirectory;
    this.uri = resourceUri;
    
    // Set checkbox state for files (not directories)
    if (!isDirectory) {
      this.checkboxState = checked 
        ? vscode.TreeItemCheckboxState.Checked 
        : vscode.TreeItemCheckboxState.Unchecked;
    }
  }
}

export class FileTreeDataProvider implements vscode.TreeDataProvider<FileTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  
  private rootItems: Map<string, FileTreeItem> = new Map();
  private checkedItems: Set<string> = new Set();
  private workspaceRoot: vscode.Uri;
  private excludePatterns: string[] = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.vscode/**',
    '**/*.log',
    '**/.DS_Store'
  ];

  constructor(workspaceRoot: vscode.Uri) {
    this.workspaceRoot = workspaceRoot;
  }

  async refresh(): Promise<void> {
    this.rootItems.clear();
    this.checkedItems.clear();
    await this.buildTree(this.workspaceRoot, '');
    this._onDidChangeTreeData.fire();
  }

  private async buildTree(dirUri: vscode.Uri, relativePath: string): Promise<FileTreeItem[]> {
    const items: FileTreeItem[] = [];
    
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      
      // Sort: directories first, then files, alphabetically
      entries.sort((a, b) => {
        if (a[1] === vscode.FileType.Directory && b[1] !== vscode.FileType.Directory) return -1;
        if (a[1] !== vscode.FileType.Directory && b[1] === vscode.FileType.Directory) return 1;
        return a[0].localeCompare(b[0]);
      });

      for (const [name, type] of entries) {
        // Skip excluded patterns
        const fullPath = relativePath ? `${relativePath}/${name}` : name;
        if (this.shouldExclude(fullPath)) continue;

        const entryUri = vscode.Uri.joinPath(dirUri, name);
        const isDir = type === vscode.FileType.Directory;
        
        const item = new FileTreeItem(
          name,
          entryUri,
          isDir,
          this.checkedItems.has(entryUri.toString())
        );

        if (isDir) {
          // Build children recursively (limit depth to avoid performance issues)
          const depth = relativePath.split('/').length;
          if (depth < 5) { // Limit to 5 levels deep
            item.children = await this.buildTree(entryUri, fullPath);
            // Hide children checkboxes in collapsed state, but show when expanded
            item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
          } else {
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            item.children = [];
          }
        }

        items.push(item);
      }
    } catch (err) {
      // Silently handle permission errors
    }
    
    return items;
  }

  private shouldExclude(relativePath: string): boolean {
    for (const pattern of this.excludePatterns) {
      const regex = new RegExp(pattern.replace('**/', '').replace('*', '.*'));
      if (regex.test(relativePath)) return true;
    }
    return false;
  }

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
    if (!element) {
      // Root level - build tree from workspace root
      if (this.rootItems.size === 0) {
        await this.refresh();
      }
      return Array.from(this.rootItems.values());
    }
    
    if (element.children) {
      return element.children;
    }
    
    return [];
  }

  async toggleCheck(uri: vscode.Uri): Promise<void> {
    const uriStr = uri.toString();
    if (this.checkedItems.has(uriStr)) {
      this.checkedItems.delete(uriStr);
    } else {
      this.checkedItems.add(uriStr);
    }
  }

  getCheckedItems(): vscode.Uri[] {
    return Array.from(this.checkedItems).map(u => vscode.Uri.parse(u));
  }

  isChecked(uri: vscode.Uri): boolean {
    return this.checkedItems.has(uri.toString());
  }
}

let fileTreeView: vscode.TreeView<FileTreeItem> | undefined;
let fileTreeProviderGlobal: FileTreeDataProvider | undefined;

export async function pickAndReadFilesFromTree(
  existing: AttachedFile[],
  provider?: FileTreeDataProvider,
  treeView?: vscode.TreeView<FileTreeItem>
): Promise<AttachedFile[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('No workspace folder is open.');
    return existing;
  }

  const workspaceRoot = workspaceFolders[0].uri;

  // Use provided provider or create/reuse global one
  const fileTreeProvider = provider || fileTreeProviderGlobal || new FileTreeDataProvider(workspaceRoot);
  if (!provider) {
    fileTreeProviderGlobal = fileTreeProvider;
  }
  await fileTreeProvider.refresh();

  // Get currently attached file URIs to mark them as checked
  const existingUris = new Set(existing.map((f: AttachedFile) => f.uri));
  for (const uri of existingUris) {
    fileTreeProvider.toggleCheck(vscode.Uri.parse(uri));
  }
  await fileTreeProvider.refresh();

  // Use provided tree view or create/reuse global one
  const currentTreeView = treeView || fileTreeView;
  
  // If no tree view provided, we can't proceed with interactive selection
  if (!currentTreeView) {
    vscode.window.showWarningMessage('File tree view not available. Please use the Attach Files button from the extension.');
    return existing;
  }

  // Create buttons for confirm/cancel
  const btnConfirm = 'Confirm Selection';
  const btnCancel = 'Cancel';

  // Show a message prompting user to select files from the tree view
  const selection = await vscode.window.showInformationMessage(
    'Select files from the file tree in the Explorer, then click Confirm.',
    { modal: false },
    btnConfirm,
    btnCancel
  );

  if (selection === btnCancel || !selection) {
    return existing;
  }

  // Get checked items from tree view selection or provider checked items
  const selectedItems = currentTreeView.selection;
  let selectedUris: vscode.Uri[] = [];
  
  if (selectedItems.length > 0) {
    selectedUris = selectedItems.filter(item => item.isFile).map(item => item.uri);
  } else {
    selectedUris = fileTreeProvider.getCheckedItems();
  }

  if (selectedUris.length === 0) {
    vscode.window.showWarningMessage('No files selected. Check the files you want to attach in the file tree.');
    return existing;
  }

  // Filter to only files (not directories)
  const fileUris: vscode.Uri[] = [];
  for (const uri of selectedUris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File) {
        fileUris.push(uri);
      }
    } catch {
      // Skip files that can't be stat'd
    }
  }

  // Build the result
  const wsRoots = workspaceFolders.map(f => f.uri.fsPath);
  const result: AttachedFile[] = [...existing];
  const resultUris = new Set(result.map((f: AttachedFile) => f.uri));

  for (const uri of fileUris) {
    const uriStr = uri.toString();
    
    // Skip already attached files
    if (resultUris.has(uriStr)) {
      continue;
    }

    // Read file bytes
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Could not read "${path.basename(uri.fsPath)}": ${String(err)}`
      );
      continue;
    }

    const sizeBytes = bytes.length;

    // Decode text; truncate if over per-file cap
    let content: string;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    if (sizeBytes > FILE_CAP_BYTES) {
      const truncated = decoder.decode(bytes.slice(0, FILE_CAP_BYTES));
      content =
        truncated +
        `\n\n[... TRUNCATED — file was ${formatBytes(sizeBytes)}, showing first ${formatBytes(FILE_CAP_BYTES)} ...]`;
    } else {
      content = decoder.decode(bytes);
    }

    // Detect language
    const languageId = await detectLanguageId(uri);

    // Compute relative path
    const relativePath = bestRelativePath(wsRoots, uri.fsPath);

    result.push({
      uri: uriStr,
      relativePath,
      languageId,
      content,
      sizeBytes,
    });

    resultUris.add(uriStr);
  }

  // Enforce total cap — drop last added files if needed
  let totalBytes = result.reduce((sum, f) => sum + Math.min(f.sizeBytes, FILE_CAP_BYTES), 0);
  while (totalBytes > TOTAL_CAP_BYTES && result.length > 0) {
    const dropped = result.pop()!;
    totalBytes -= Math.min(dropped.sizeBytes, FILE_CAP_BYTES);
    vscode.window.showWarningMessage(
      `Dropped "${dropped.relativePath}" — total context would exceed ${formatBytes(TOTAL_CAP_BYTES)}.`
    );
  }

  return result;
}

export async function pickAndReadFiles(
  existing: AttachedFile[]
): Promise<AttachedFile[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('No workspace folder is open.');
    return existing;
  }

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFolders: false,
    openLabel: 'Attach',
    defaultUri: workspaceFolders[0].uri,
    title: 'Attach files to context',
  });

  if (!uris || uris.length === 0) {
    return existing;
  }

  // Determine the workspace root strings for boundary checks
  const wsRoots = workspaceFolders.map(f => f.uri.fsPath);

  const result: AttachedFile[] = [...existing];
  const existingUris = new Set(existing.map((f: AttachedFile) => f.uri));

  for (const uri of uris) {
    // Restrict to workspace
    const fsPath = uri.fsPath;
    const inWorkspace = wsRoots.some((root: string) =>
      fsPath === root || fsPath.startsWith(root + path.sep)
    );
    if (!inWorkspace) {
      vscode.window.showWarningMessage(
        `Skipped "${path.basename(fsPath)}" — outside workspace.`
      );
      continue;
    }

    // Skip duplicates
    if (existingUris.has(uri.toString())) {
      continue;
    }

    // Detect language
    const languageId = await detectLanguageId(uri);

    // Read file bytes
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Could not read "${path.basename(fsPath)}": ${String(err)}`
      );
      continue;
    }

    const sizeBytes = bytes.length;

    // Decode text; truncate if over per-file cap
    let content: string;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    if (sizeBytes > FILE_CAP_BYTES) {
      const truncated = decoder.decode(bytes.slice(0, FILE_CAP_BYTES));
      content =
        truncated +
        `\n\n[... TRUNCATED — file was ${formatBytes(sizeBytes)}, showing first ${formatBytes(FILE_CAP_BYTES)} ...]`;
    } else {
      content = decoder.decode(bytes);
    }

    // Compute relative path
    const relativePath = bestRelativePath(wsRoots, fsPath);

    result.push({
      uri: uri.toString(),
      relativePath,
      languageId,
      content,
      sizeBytes,
    });

    existingUris.add(uri.toString());
  }

  // Enforce total cap — drop last-added files if needed
  let totalBytes = result.reduce((sum, f) => sum + Math.min(f.sizeBytes, FILE_CAP_BYTES), 0);
  while (totalBytes > TOTAL_CAP_BYTES && result.length > 0) {
    const dropped = result.pop()!;
    totalBytes -= Math.min(dropped.sizeBytes, FILE_CAP_BYTES);
    vscode.window.showWarningMessage(
      `Dropped "${dropped.relativePath}" — total context would exceed ${formatBytes(TOTAL_CAP_BYTES)}.`
    );
  }

  return result;
}

async function detectLanguageId(uri: vscode.Uri): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.languageId;
  } catch {
    // Fall back to extension-based heuristic
    return extensionToLanguageId(uri.fsPath);
  }
}

function extensionToLanguageId(fsPath: string): string {
  const ext = path.extname(fsPath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescriptreact',
    '.js': 'javascript', '.jsx': 'javascriptreact',
    '.py': 'python', '.rs': 'rust', '.go': 'go',
    '.java': 'java', '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.html': 'html', '.css': 'css',
    '.sh': 'shellscript', '.bash': 'shellscript',
  };
  return map[ext] ?? 'plaintext';
}

function bestRelativePath(wsRoots: string[], fsPath: string): string {
  for (const root of wsRoots) {
    if (fsPath === root || fsPath.startsWith(root + path.sep)) {
      return path.relative(root, fsPath).replace(/\\/g, '/');
    }
  }
  return path.basename(fsPath);
}

function formatBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
