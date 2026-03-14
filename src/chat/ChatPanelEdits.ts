import * as vscode from 'vscode';
import { parseEditOps, resolveEditPath, applyAnchorOp } from '../tools/editParser';
import { DiffContentProvider } from './DiffContentProvider';

const DIFF_SCHEME = 'agentic-diff';

export interface EditDeps {
  log: vscode.OutputChannel;
  diffProvider: DiffContentProvider;
  postMessage: (message: unknown) => void;
  requestApproval: (action: string, payload: unknown, reason?: string) => Promise<boolean>;
  pushHistory: (message: { role: 'user' | 'assistant'; content: string; displayContent?: string }) => void;
  saveSession: () => void | Promise<void>;
}

export class ChatPanelEdits {
  constructor(private deps: EditDeps) {}

  /**
   * Parse JSON anchor edit ops from the assistant response and open a VS Code
   * diff tab for each one so the user can review changes before applying.
   */
  async processEdits(assistantText: string): Promise<void> {
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    if (wsRoots.length === 0) {
      return;
    }

    const { ops, warnings } = parseEditOps(assistantText);

    this.deps.log.appendLine(`[edit] ops found: ${ops.length}, warnings: ${warnings.length}`);
    for (const op of ops) {
      const anchorPreview = op.anchor !== undefined
        ? JSON.stringify(op.anchor.length > 80 ? op.anchor.slice(0, 80) + '…' : op.anchor)
        : '(none)';
      this.deps.log.appendLine(`[edit] op=${op.op} uri=${op.uri} anchor=${anchorPreview}`);
    }
    for (const w of warnings) {
      this.deps.log.appendLine(`[edit] warning: ${w}`);
      this.deps.postMessage({ type: 'status', text: `Edit parse warning: ${w}` });
    }

    const resultLines: string[] = [];

    for (const op of ops) {
      const pathResult = resolveEditPath(op.uri, wsRoots);
      if (pathResult.error) {
        const errMsg = `\n\n> **Edit error**: ${pathResult.error}`;
        this.deps.postMessage({ type: 'delta', content: errMsg });
        resultLines.push(`<EDIT_RESULT path="${op.uri}" status="failed" error="${pathResult.error}"/>`);
        continue;
      }

      const fileUri = vscode.Uri.file(pathResult.resolvedPath!);

      // Read current file content (may not exist yet for new-file ops)
      let originalContent = '';
      let fileExists = true;
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        originalContent = Buffer.from(bytes).toString('utf8');
      } catch {
        // File doesn't exist — treat as empty (new file)
        fileExists = false;
      }

      // Apply the operation to compute new content
      const result = applyAnchorOp(op, originalContent);
      if (typeof result === 'object') {
        const errMsg = `\n\n> **Edit error** (${op.uri}): ${result.error}. Try attaching the file first so the model can read the current content.`;
        this.deps.postMessage({ type: 'delta', content: errMsg });
        resultLines.push(`<EDIT_RESULT path="${op.uri}" status="failed" error="${result.error}"/>`);
        continue;
      }
      const newContent = result;

      // Register both sides with the in-memory provider (only when diffing existing files)
      let oldUri: vscode.Uri | undefined;
      let newUri: vscode.Uri | undefined;
      if (fileExists) {
        const oldKey = `${op.uri}?side=old`;
        const newKey = `${op.uri}?side=new`;
        this.deps.diffProvider.set(oldKey, originalContent);
        this.deps.diffProvider.set(newKey, newContent);

        oldUri = vscode.Uri.parse(`${DIFF_SCHEME}:${oldKey}`);
        newUri = vscode.Uri.parse(`${DIFF_SCHEME}:${newKey}`);
        const title = `Review: ${op.uri}`;

        await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, {
          preview: true,
        });
      }

      // Ask via the in-chat approval card (cannot be accidentally dismissed).
      const approved = await this.deps.requestApproval(
        'applyEdit',
        { path: op.uri },
        `op: ${op.op}`
      );

      // Close the diff editor tab and clean up the in-memory provider entries.
      if (fileExists && oldUri && newUri) {
        const oldKey = `${op.uri}?side=old`;
        const newKey = `${op.uri}?side=new`;
        const diffTabsToClose: vscode.Tab[] = [];
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputTextDiff) {
              const oUri = tab.input.original.toString();
              const mUri = tab.input.modified.toString();
              if (oUri === oldUri.toString() || mUri === newUri.toString()) {
                diffTabsToClose.push(tab);
              }
            }
          }
        }
        if (diffTabsToClose.length > 0) {
          await vscode.window.tabGroups.close(diffTabsToClose);
        }
        this.deps.diffProvider.delete(oldKey);
        this.deps.diffProvider.delete(newKey);
      }

      this.deps.log.appendLine(`[edit] user answered: ${approved ? 'Apply' : 'Deny'} for ${op.uri}`);
      if (!approved) {
        this.deps.postMessage({ type: 'status', text: `Edit cancelled: ${op.uri}` });
        this.deps.postMessage({ type: 'editResult', uri: op.uri, outcome: 'cancelled' });
        resultLines.push(`<EDIT_RESULT path="${op.uri}" status="denied by user"/>`);
        continue;
      }

      // Apply via WorkspaceEdit for undo history support; fall back to writeFile for new files.
      // Use LF-only content — VSCode normalises to the document's EOL on write.
      const lfContent = newContent.replace(/\r\n/g, '\n');
      if (fileExists) {
        const wsEdit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        wsEdit.replace(fileUri, fullRange, lfContent);
        await vscode.workspace.applyEdit(wsEdit);
        await doc.save();
      } else {
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(lfContent));
      }
      this.deps.log.appendLine(`[edit] applied: ${op.uri}`);
      this.deps.postMessage({ type: 'status', text: `Applied: ${op.uri}` });
      this.deps.postMessage({ type: 'editResult', uri: op.uri, outcome: 'applied' });
      resultLines.push(`<EDIT_RESULT path="${op.uri}" status="applied"/>`);
    }

    if (resultLines.length > 0) {
      // Feed edit outcomes back to the model as a user message so it knows
      // which edits were applied, denied, or failed.
      this.deps.pushHistory({ role: 'user', content: resultLines.join('\n') });
      this.deps.saveSession();
    }
  }
}