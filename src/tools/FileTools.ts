import * as vscode from 'vscode';
import * as path from 'path';
import { AttachedFile } from '../chat/messageProtocol';

const FILE_CAP_BYTES = 300 * 1024;   // 300 KB per file
const TOTAL_CAP_BYTES = 1.5 * 1024 * 1024; // 1.5 MB total

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
