import * as vscode from 'vscode';

/** In-memory content provider for diff previews. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
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