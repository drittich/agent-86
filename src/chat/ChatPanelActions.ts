import * as vscode from 'vscode';
import { parseRunBlocks, runCommand, formatRunResult } from '../tools/TerminalTool';
import { parseMoveBlocks, resolveMoveBlockPath, moveFile, formatMoveResult } from '../tools/MoveFileTool';
import { parseDeleteBlocks, resolveDeleteBlockPath, deleteFile, formatDeleteResult } from '../tools/DeleteFileTool';

export interface ActionDeps {
  log: vscode.OutputChannel;
  postMessage: (message: unknown) => void;
  requestApproval: (action: string, payload: unknown, reason?: string) => Promise<boolean>;
  pushHistory: (message: { role: 'user' | 'assistant'; content: string; displayContent?: string }) => void;
  saveSession: () => void | Promise<void>;
}

export class ChatPanelActions {
  constructor(private deps: ActionDeps) {}

  /**
   * Parse @@RUN blocks from the assistant response, request approval for each,
   * execute approved commands, and append a summary back into the conversation
   * so the model can see the output.
   */
  async processRunBlocks(assistantText: string): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    if (wsRoots.length === 0) {
      return;
    }

    const cwd = wsRoots[0].uri.fsPath;
    const blocks = parseRunBlocks(assistantText);
    if (blocks.length === 0) {
      return;
    }

    const resultLines: string[] = [];

    for (const block of blocks) {
      const approved = await this.deps.requestApproval(
        'runCommand',
        { command: block.command },
        'The assistant wants to run a terminal command.'
      );

      if (!approved) {
        this.deps.postMessage({ type: 'status', text: `Command cancelled: ${block.command}` });
        resultLines.push(`<RUN_RESULT command="${block.command}" status="cancelled by user"/>`);
        continue;
      }

      this.deps.postMessage({ type: 'status', text: `Running: ${block.command}` });
      const result = await runCommand(block.command, cwd);
      const summary = formatRunResult(result);
      resultLines.push(summary);

      const statusText = result.timedOut
        ? `Timed out: ${block.command}`
        : `Done (exit ${result.exitCode ?? '?'}): ${block.command}`;
      this.deps.postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this.deps.pushHistory({ role: 'user', content: feedbackContent });
    this.deps.saveSession();
  }

  /**
   * Parse @@MOVE blocks from the assistant response, request approval for each,
   * execute approved moves, and append a summary back into the conversation
   * so the model can see the result.
   */
  async processMoveBlocks(assistantText: string): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    if (wsRoots.length === 0) {
      return;
    }

    const wsRootPaths = wsRoots.map(f => f.uri.fsPath);
    const blocks = parseMoveBlocks(assistantText);
    if (blocks.length === 0) {
      return;
    }

    const resultLines: string[] = [];

    for (const block of blocks) {
      const fromAbsolute = resolveMoveBlockPath(block.from, wsRootPaths);
      const toAbsolute = resolveMoveBlockPath(block.to, wsRootPaths);

      if (!fromAbsolute) {
        const msg = `Move blocked: source path "${block.from}" is outside the workspace.`;
        this.deps.postMessage({ type: 'status', text: msg });
        resultLines.push(`<MOVE_RESULT from="${block.from}" to="${block.to}" status="failed" error="${msg}"/>`);
        continue;
      }

      if (!toAbsolute) {
        const msg = `Move blocked: destination path "${block.to}" is outside the workspace.`;
        this.deps.postMessage({ type: 'status', text: msg });
        resultLines.push(`<MOVE_RESULT from="${block.from}" to="${block.to}" status="failed" error="${msg}"/>`);
        continue;
      }

      const approved = await this.deps.requestApproval(
        'moveFile',
        { from: block.from, to: block.to },
        'The assistant wants to move a file.'
      );

      if (!approved) {
        this.deps.postMessage({ type: 'status', text: `Move cancelled: ${block.from} → ${block.to}` });
        resultLines.push(`<MOVE_RESULT from="${block.from}" to="${block.to}" status="cancelled by user"/>`);
        continue;
      }

      this.deps.postMessage({ type: 'status', text: `Moving: ${block.from} → ${block.to}` });
      const result = await moveFile(fromAbsolute, toAbsolute);
      const summary = formatMoveResult(result);
      resultLines.push(summary);

      const statusText = result.success
        ? `Moved: ${block.from} → ${block.to}`
        : `Move failed: ${result.error}`;
      this.deps.postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this.deps.pushHistory({ role: 'user', content: feedbackContent });
    this.deps.saveSession();
  }

  /**
   * Parse @@DELETE blocks from the assistant response, request approval for each,
   * execute approved deletions (to trash), and append a summary back into the
   * conversation so the model can see the result.
   */
  async processDeleteBlocks(assistantText: string): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    if (wsRoots.length === 0) {
      return;
    }

    const wsRootPaths = wsRoots.map(f => f.uri.fsPath);
    const blocks = parseDeleteBlocks(assistantText);
    if (blocks.length === 0) {
      return;
    }

    const resultLines: string[] = [];

    for (const block of blocks) {
      const fileAbsolute = resolveDeleteBlockPath(block.filePath, wsRootPaths);

      if (!fileAbsolute) {
        const msg = `Delete blocked: path "${block.filePath}" is outside the workspace.`;
        this.deps.postMessage({ type: 'status', text: msg });
        resultLines.push(`<DELETE_RESULT path="${block.filePath}" status="failed" error="${msg}"/>`);
        continue;
      }

      const approved = await this.deps.requestApproval(
        'deleteFile',
        { path: block.filePath },
        'The assistant wants to delete a file (will be moved to trash).'
      );

      if (!approved) {
        this.deps.postMessage({ type: 'status', text: `Delete cancelled: ${block.filePath}` });
        resultLines.push(`<DELETE_RESULT path="${block.filePath}" status="cancelled by user"/>`);
        continue;
      }

      this.deps.postMessage({ type: 'status', text: `Deleting: ${block.filePath}` });
      const result = await deleteFile(fileAbsolute);
      const summary = formatDeleteResult(result);
      resultLines.push(summary);

      const statusText = result.success
        ? `Deleted (trashed): ${block.filePath}`
        : `Delete failed: ${result.error}`;
      this.deps.postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this.deps.pushHistory({ role: 'user', content: feedbackContent });
    this.deps.saveSession();
  }

  /**
   * Process all action blocks (Run, Move, Delete) from the assistant response.
   */
  async processAllActions(assistantText: string): Promise<void> {
    await this.processRunBlocks(assistantText);
    await this.processMoveBlocks(assistantText);
    await this.processDeleteBlocks(assistantText);
  }
}