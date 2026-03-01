import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewToExtension, ExtensionToWebview, AttachedFile } from './messageProtocol';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { ChatMessage } from '../providers/IProvider';
import { readActiveEditor, autoDetectAndAttachFiles, FILE_EXCLUDE_GLOB } from '../tools/FileTools';
import { parseEditOps, resolveEditPath, applyAnchorOp } from '../tools/editParser';
import {
  chunkFile, formatChunkBlock, buildChunkMeta, parseChunkRequests,
  parseFileRequests, formatFileListBlock,
  extractPromptTokens, selectBestChunk,
  FileChunkMeta, FileChunk, ChunkRequest,
} from '../tools/ChunkManager';
import { parseRunBlocks, runCommand, formatRunResult } from '../tools/TerminalTool';
import { parseMoveBlocks, resolveMoveBlockPath, moveFile, formatMoveResult } from '../tools/MoveFileTool';
import { parseDeleteBlocks, resolveDeleteBlockPath, deleteFile, formatDeleteResult } from '../tools/DeleteFileTool';
import { ConfigManager, Session } from '../config/ConfigManager';

const DIFF_SCHEME = 'agentic-diff';

/** In-memory content provider for diff previews. */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
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

export class ChatPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _abortController?: AbortController;
  private readonly _log: vscode.OutputChannel;
  /** Set to true when the user explicitly clicks Stop; cleared on new send. */
  private _userCancelled = false;
  private _history: ChatMessage[] = [];
  private _attachedFiles: AttachedFile[] = [];
  /** Tracks which attached file URIs have already been injected into _history. */
  private _injectedFileUris = new Set<string>();
  /** Maps workspace-relative URI → chunk metadata for files chunked in the current session. */
  private _chunkMeta = new Map<string, FileChunkMeta>();
  private readonly _diffProvider = new DiffContentProvider();
  /** Pending approval resolvers keyed by approvalId. */
  private readonly _approvalResolvers = new Map<string, (approved: boolean) => void>();
  private _approvalCounter = 0;
  private readonly _configManager: ConfigManager;
  private _currentSession: Session;

  // Backpressure handling: buffer deltas when webview is hidden
  private _isViewVisible = true;
  private _deltaBuffer: string[] = [];

  // Track active editor state
  private _hasActiveEditor = false;
  private _thinkingMode = false;
  private _includeAgentsMd = false;

  constructor(private readonly context: vscode.ExtensionContext, log: vscode.OutputChannel) {
    this._log = log;
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this._diffProvider)
    );
    this._configManager = new ConfigManager(context);
    // Restore last session, or start a fresh one
    const restored = this._configManager.loadLastSession();
    if (restored) {
      this._currentSession = restored;
      this._history = restored.messages;
      this._attachedFiles = restored.attachments;
      // All restored attachments are already baked into history — don't re-inject them
      this._injectedFileUris = new Set(restored.attachments.map(f => f.uri));
      this._thinkingMode = restored.thinkingMode ?? false;
      this._includeAgentsMd = restored.includeAgentsMd ?? false;
    } else {
      this._currentSession = this._configManager.createSession();
    }

    // Track active editor state changes
    this._hasActiveEditor = !!vscode.window.activeTextEditor;
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this._hasActiveEditor = !!vscode.window.activeTextEditor;
        this._postMessage({ type: 'editorState', hasActiveEditor: this._hasActiveEditor });
      })
    );
  }

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

    // Track visibility for backpressure handling
    this._isViewVisible = webviewView.visible;
    webviewView.onDidChangeVisibility(() => {
      this._isViewVisible = webviewView.visible;
      if (this._isViewVisible && this._deltaBuffer.length > 0) {
        this._flushDeltaBuffer();
      }
    });

    // Restore UI state from the current session once the webview is ready
    this._restoreSessionUi();

    // Notify webview whether AGENTS.md exists in the workspace root
    this._notifyAgentsMdAvailability();
  }

  public reveal(): void {
    if (this._view) {
      this._view.show(true);
    } else {
      vscode.commands.executeCommand('agenticCoder.panel.focus');
    }
  }

  public newSession(): void {
    this._abortController?.abort();
    this._abortController = undefined;
    this._history = [];
    this._attachedFiles = [];
    this._injectedFileUris = new Set();
    this._chunkMeta = new Map();
    this._thinkingMode = false;
    this._includeAgentsMd = false;
    this._currentSession = this._configManager.createSession();
    this._saveCurrentSession();
    this._postMessage({ type: 'attachments', files: [] });
    this._postMessage({ type: 'status', text: 'New session started.' });
  }

  public attachFiles(): void {
    this._handleMessage({ type: 'attachFiles' });
  }

  /**
   * Get the currently attached files (used by the file tree picker).
   */
  public getAttachedFiles(): AttachedFile[] {
    return this._attachedFiles;
  }

  /**
   * Update the attached files list (used by the file tree picker).
   */
  public updateAttachedFiles(files: AttachedFile[]): void {
    this._attachedFiles = files;
    this._postMessage({ type: 'attachments', files });
    this._saveCurrentSession();
  }

  /**
   * Restore a session (used by the quick-pick feature).
   */
  public restoreSession(session: Session): void {
    this._abortController?.abort();
    this._abortController = undefined;
    this._history = session.messages;
    this._attachedFiles = session.attachments;
    // Mark all restored attachments as already injected (they're baked into history)
    this._injectedFileUris = new Set(session.attachments.map(f => f.uri));
    this._chunkMeta = new Map();
    this._thinkingMode = session.thinkingMode ?? false;
    this._includeAgentsMd = session.includeAgentsMd ?? false;
    this._currentSession = session;
    this._postMessage({ type: 'status', text: `Restored session: ${session.title}` });
    this._restoreSessionUi();
  }

  /**
   * Get the ConfigManager instance (used by quick-pick).
   */
  public getConfigManager(): ConfigManager {
    return this._configManager;
  }

  /**
   * Read, chunk, and cache metadata for a single file.
   * Returns the chunks array, or null if the file cannot be read.
   */
  private async _getChunksForUri(
    relativePath: string,
    wsRoots: string[]
  ): Promise<FileChunk[] | null> {
    const pathResult = resolveEditPath(relativePath, wsRoots);
    if (pathResult.error) {
      this._log.appendLine(`[chunks] cannot resolve "${relativePath}": ${pathResult.error}`);
      return null;
    }
    const fileUri = vscode.Uri.file(pathResult.resolvedPath!);
    let content: string;
    let docVersion: number;
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      content = doc.getText();
      docVersion = doc.version;
    } catch {
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        content = Buffer.from(bytes).toString('utf8');
        docVersion = 0;
      } catch {
        this._log.appendLine(`[chunks] cannot read "${relativePath}"`);
        return null;
      }
    }
    const chunks = chunkFile(relativePath, content, docVersion);
    this._chunkMeta.set(relativePath, buildChunkMeta(chunks));
    return chunks;
  }

  /**
   * Select chunks to fulfil a `request_chunks` request.
   * Centres on `preferred.near_line` if given; defaults to first N chunks.
   */
  private _selectChunksForRequest(
    chunks: FileChunk[],
    preferred?: ChunkRequest['preferred']
  ): FileChunk[] {
    const maxChunks = preferred?.max_chunks ?? 2;
    const nearLine = preferred?.near_line;
    if (!nearLine) {
      return chunks.slice(0, maxChunks);
    }
    // Find chunk whose lineStart is closest to nearLine
    let bestIdx = 0;
    let bestDist = Math.abs(chunks[0].lineStart - nearLine);
    for (let i = 1; i < chunks.length; i++) {
      const dist = Math.abs(chunks[i].lineStart - nearLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const half = Math.floor(maxChunks / 2);
    const start = Math.max(0, bestIdx - half);
    return chunks.slice(start, start + maxChunks);
  }

  private _getProvider(): OpenAIProvider {
    const cfg = vscode.workspace.getConfiguration('agentCoder');
    const baseUrl = cfg.get<string>('baseUrl') ?? 'http://127.0.0.1:8083/v1';
    const model = cfg.get<string>('model') ?? 'gpt-3.5-turbo';
    const apiKey = cfg.get<string>('apiKey') ?? 'local';
    return new OpenAIProvider(baseUrl, model, apiKey, this._log);
  }

  private _buildMessages(agentsMdContent?: string): ChatMessage[] {
    const thinkToken = this._thinkingMode ? '/think' : '/no_think';
    const behaviorInstructions = this._thinkingMode
    ? `Deliberate before acting. When done, briefly summarize what changed (and why if not obvious).`
    : `Act without preamble. No planning narration; no repetition. Afterward: one brief confirmation or nothing.`;
  const agentsMdSection = agentsMdContent
    ? `\n\n## AGENTS.md\n${agentsMdContent}`
    : '';
    const systemPrompt: ChatMessage = {
      role: 'system',
      content: `You are a VS Code coding assistant.${agentsMdSection}

${behaviorInstructions}

## Files
Files arrive as \`<file_chunk path uri chunk_id lines total_chunks doc_version hash>\` blocks. You may only receive the first 1–2 chunks initially.

## Requesting data
Emit ONE of these JSON objects instead of \`edits\` (max 2 rounds each; do not combine with \`edits\` or each other):

**More chunks:** \`{"request_chunks":[{"uri":"src/foo.ts","reason":"…","preferred":{"near_line":250,"max_chunks":2}}]}\`

**File listing:** \`{"request_files":[{"glob":"src/**/*.ts","reason":"…"}]}\` → returns \`<file_list glob count>paths…</file_list>\`. Be specific with globs; \`node_modules\`, \`.git\`, \`dist\`, \`build\` are excluded.

## Editing files
Output anywhere in your response (optionally in a \`\`\`json fence):
\`\`\`json
{"edits":[{"uri":"src/file.ts","op":"replace_first","anchor":"exact text","text":"replacement"}]}
\`\`\`
Ops: \`replace_first\` · \`delete_first\` (omit text) · \`insert_after\` · \`insert_before\` · \`replace_all\` (omit anchor, replaces whole file).
URIs: workspace-relative, forward slashes, no leading slash. Anchor must match exactly — copy verbatim from the chunk. If you haven't read the file, use \`replace_all\`.

## Shell / file ops
\`\`\`
<RUN>command</RUN>                         result fed back as <RUN_RESULT>; use only when needed
<MOVE>\\nFROM: old/path\\nTO: new/path\\n</MOVE>   both paths must be inside workspace
<DELETE>\\nPATH: path/to/file\\n</DELETE>        moved to OS trash; only when user explicitly asks
\`\`\``,
    };
    // Qwen3 only honours /think and /no_think in user messages, not system.
    // Prepend the token to the last user message so it takes effect each turn.
    const history = this._history.map((msg, i) => {
      if (msg.role === 'user' && i === this._history.length - 1) {
        return { ...msg, content: `${thinkToken}\n${msg.content}` };
      }
      return msg;
    });
    const messages = [systemPrompt, ...history];
    this._log.appendLine(`[buildMessages] ${messages.length} message(s), thinkToken=${thinkToken}`);
    for (const m of messages) {
      const preview = m.content.slice(0, 120).replace(/\n/g, '↵');
      this._log.appendLine(`  [${m.role}] ${preview}${m.content.length > 120 ? `… (${m.content.length} chars)` : ''}`);
    }
    return messages;
  }

  private async _handleSend(prompt: string): Promise<void> {
    if (this._abortController) {
      // Already generating — ignore duplicate sends
      return;
    }
    this._userCancelled = false;

    // Auto-detect file references in the prompt and attach them before sending
    const autoAttached = await autoDetectAndAttachFiles(prompt, this._attachedFiles);
    if (autoAttached.length > this._attachedFiles.length) {
      this._attachedFiles = autoAttached;
      this._postMessage({ type: 'attachments', files: this._attachedFiles });
    }

    // Build user message, prepending any attached files that haven't been injected yet
    let userContent = prompt;
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const newFiles = this._attachedFiles.filter(f => !this._injectedFileUris.has(f.uri));
    /** Chunk IDs delivered in the initial user message — seeded into sentChunkIds below. */
    const initialChunkIds: string[] = [];
    if (newFiles.length > 0) {
      const chunkBlocks: string[] = [];
      const promptTokens = extractPromptTokens(prompt);
      const wsRoot = wsRoots[0] ?? '';
      for (const f of newFiles) {
        const chunks = await this._getChunksForUri(f.relativePath, wsRoots);
        if (chunks && chunks.length > 0) {
          const absolutePath = path.join(wsRoot, f.relativePath);
          this._postMessage({ type: 'status', text: `Searching ${f.relativePath}…` });
          const best = await selectBestChunk(chunks, absolutePath, promptTokens);
          chunkBlocks.push(formatChunkBlock(best));
          initialChunkIds.push(best.chunkId);
          this._log.appendLine(`[chunks] sending ${best.uri} lines ${best.lineStart}-${best.lineEnd} (rg-scored, total=${best.totalChunks})`);
        } else {
          // Fallback for unreadable/unsaved files
          chunkBlocks.push(
            `<file path="${f.relativePath}" language="${f.languageId}">\n${f.content}\n</file>`
          );
        }
        this._injectedFileUris.add(f.uri);
      }
      if (chunkBlocks.length > 0) {
        this._postMessage({ type: 'status', text: `Sending chunks for ${newFiles.length} file(s)…` });
        userContent = `${chunkBlocks.join('\n\n')}\n\n${prompt}`;
      }
    }

    this._history.push({ role: 'user', content: userContent, displayContent: prompt });

    // Read AGENTS.md once for this send if the user has opted in
    let agentsMdContent: string | undefined;
    if (this._includeAgentsMd && wsRoots.length > 0) {
      const agentsMdUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'AGENTS.md');
      try {
        const bytes = await vscode.workspace.fs.readFile(agentsMdUri);
        agentsMdContent = Buffer.from(bytes).toString('utf8');
      } catch {
        // AGENTS.md disappeared between check and send — ignore
      }
    }

    const MAX_FILE_ROUNDS = 2;
    let fileRound = 0;
    const MAX_CHUNK_ROUNDS = 2;
    let chunkRound = 0;
    /** Chunk IDs that have already been sent to the model in this turn. */
    const sentChunkIds = new Set<string>(initialChunkIds);
    let finalResponse = '';
    let lastUsage: import('../providers/IProvider').ProviderUsage | undefined;

    try {
      while (true) {
        let fullResponse = '';
        this._abortController = new AbortController();
        const provider = this._getProvider();

        this._log.appendLine(`[stream] starting request (chunk round ${chunkRound})`);
        await provider.stream(
          this._buildMessages(agentsMdContent),
          this._abortController.signal,
          (event) => {
            if (event.type === 'delta') {
              fullResponse += event.content;
              this._postMessage({ type: 'delta', content: event.content });
            } else if (event.type === 'done') {
              this._log.appendLine(`[stream] done, fullResponse.length=${fullResponse.length}`);
              lastUsage = event.usage;
            } else if (event.type === 'error') {
              this._log.appendLine(`[stream] error event: ${event.message}`);
              this._postMessage({ type: 'error', message: event.message });
            }
          }
        );
        this._log.appendLine(`[stream] stream() resolved, fullResponse.length=${fullResponse.length}`);
        this._abortController = undefined;

        if (this._userCancelled || !fullResponse) {
          break;
        }

        // Tentatively record assistant turn
        this._history.push({ role: 'assistant', content: fullResponse });

        // Check if the model is requesting a file listing
        const fileRequests = parseFileRequests(fullResponse);
        if (fileRequests && fileRound < MAX_FILE_ROUNDS) {
          fileRound++;
          this._log.appendLine(`[files] ${fileRequests.length} glob request(s), round ${fileRound}/${MAX_FILE_ROUNDS}`);
          this._postMessage({ type: 'status', text: `Searching ${fileRequests.length} glob pattern(s)…` });
          const parts: string[] = [];
          for (const req of fileRequests) {
            this._log.appendLine(`[files] glob="${req.glob}" reason="${req.reason ?? ''}"`);
            let uris: vscode.Uri[] = [];
            try { uris = await vscode.workspace.findFiles(req.glob, FILE_EXCLUDE_GLOB, 200); }
            catch (err) { this._log.appendLine(`[files] findFiles error: ${err}`); }
            // Retry with case-insensitive basename matching if nothing matched
            if (uris.length === 0) {
              const basenameMatch = req.glob.match(/^(.*\/)([^/*]+)$/);
              if (basenameMatch) {
                const [, dir, base] = basenameMatch;
                const relaxed = `${dir}*`;
                const baseLower = base.toLowerCase();
                try {
                  const all = await vscode.workspace.findFiles(relaxed, FILE_EXCLUDE_GLOB, 500);
                  uris = all.filter(u => path.basename(u.fsPath).toLowerCase() === baseLower);
                  if (uris.length > 0) {
                    this._log.appendLine(`[files] case-insensitive retry matched ${uris.length} file(s) for "${req.glob}"`);
                  }
                } catch (err) { this._log.appendLine(`[files] case-insensitive retry error: ${err}`); }
              }
            }
            const paths = uris.map(u => {
              for (const root of wsRoots) {
                if (u.fsPath.startsWith(root + path.sep) || u.fsPath === root) {
                  return u.fsPath.slice(root.length + 1).replace(/\\/g, '/');
                }
              }
              return u.fsPath.replace(/\\/g, '/');
            }).sort();
            parts.push(formatFileListBlock(req.glob, paths));
            this._log.appendLine(`[files] matched ${paths.length} file(s)`);
          }
          this._history.push({ role: 'user', content: parts.join('\n\n') });
          continue;
        }

        // Check if the model is requesting more file chunks
        const chunkRequests = parseChunkRequests(fullResponse);

        if (chunkRequests && chunkRound < MAX_CHUNK_ROUNDS) {
          chunkRound++;
          this._log.appendLine(`[chunks] model requested ${chunkRequests.length} chunk(s), round ${chunkRound}/${MAX_CHUNK_ROUNDS}`);
          this._postMessage({ type: 'status', text: `Fetching ${chunkRequests.length} requested chunk(s)…` });

          const parts: string[] = [];
          for (const req of chunkRequests) {
            const chunks = await this._getChunksForUri(req.uri, wsRoots);
            if (!chunks) {
              this._log.appendLine(`[chunks] could not read "${req.uri}" — skipping`);
              parts.push(`<!-- Could not read chunks for "${req.uri}" — file not found or outside workspace -->`);
              continue;
            }
            const selected = this._selectChunksForRequest(chunks, req.preferred);
            for (const chunk of selected) {
              if (sentChunkIds.has(chunk.chunkId)) {
                this._log.appendLine(`[chunks] skipping already-sent chunk ${chunk.chunkId}`);
                continue;
              }
              sentChunkIds.add(chunk.chunkId);
              parts.push(formatChunkBlock(chunk));
              this._log.appendLine(`[chunks] sending ${chunk.uri} lines ${chunk.lineStart}-${chunk.lineEnd} (${chunk.chunkId}, total=${chunk.totalChunks})`);
            }
          }
          if (parts.length === 0) {
            this._log.appendLine(`[chunks] all requested chunks already sent — stopping chunk loop`);
            this._postMessage({ type: 'status', text: 'No new chunks to send. Try specifying a line number or attaching more of the file.' });
            finalResponse = fullResponse;
            break;
          }
          this._history.push({ role: 'user', content: parts.join('\n\n') });
          continue; // stream again with expanded context
        }

        if (chunkRequests) {
          // Limit reached while model still wants more
          this._log.appendLine(`[chunks] retry limit reached`);
          this._postMessage({ type: 'status', text: 'Chunk request limit reached. Try attaching more of the file manually.' });
        }

        finalResponse = fullResponse;
        break;
      }

      // Post 'done' exactly once after all rounds complete
      if (!this._userCancelled) {
        this._postMessage({ type: 'done', usage: lastUsage });
      }

      // Process action blocks on the final response only
      if (finalResponse && !this._userCancelled) {
        await this._showEditDiffs(finalResponse);
        await this._processRunBlocks(finalResponse);
        await this._processMoveBlocks(finalResponse);
        await this._processDeleteBlocks(finalResponse);
      }
    } catch (err) {
      this._log.appendLine(`[stream] caught exception: ${err}`);
      throw err;
    } finally {
      this._abortController = undefined;
    }

    // Persist session after each completed turn (skip if cancelled mid-stream
    // with no content, to avoid storing an empty assistant turn)
    if (finalResponse || !this._userCancelled) {
      this._saveCurrentSession();
    }
  }

  /**
   * Parse JSON anchor edit ops from the assistant response and open a VS Code
   * diff tab for each one so the user can review changes before applying.
   */
  private async _showEditDiffs(assistantText: string): Promise<void> {
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    if (wsRoots.length === 0) {
      return;
    }

    const { ops, warnings } = parseEditOps(assistantText);

    this._log.appendLine(`[edit] ops found: ${ops.length}, warnings: ${warnings.length}`);
    for (const op of ops) {
      const anchorPreview = op.anchor !== undefined
        ? JSON.stringify(op.anchor.length > 80 ? op.anchor.slice(0, 80) + '…' : op.anchor)
        : '(none)';
      this._log.appendLine(`[edit] op=${op.op} uri=${op.uri} anchor=${anchorPreview}`);
    }
    for (const w of warnings) {
      this._log.appendLine(`[edit] warning: ${w}`);
      this._postMessage({ type: 'status', text: `Edit parse warning: ${w}` });
    }

    for (const op of ops) {
      const pathResult = resolveEditPath(op.uri, wsRoots);
      if (pathResult.error) {
        const errMsg = `\n\n> **Edit error**: ${pathResult.error}`;
        this._postMessage({ type: 'delta', content: errMsg });
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
        this._postMessage({ type: 'delta', content: errMsg });
        continue;
      }
      const newContent = result;

      // Register both sides with the in-memory provider (only when diffing existing files)
      let oldUri: vscode.Uri | undefined;
      let newUri: vscode.Uri | undefined;
      if (fileExists) {
        const oldKey = `${op.uri}?side=old`;
        const newKey = `${op.uri}?side=new`;
        this._diffProvider.set(oldKey, originalContent);
        this._diffProvider.set(newKey, newContent);

        oldUri = vscode.Uri.parse(`${DIFF_SCHEME}:${oldKey}`);
        newUri = vscode.Uri.parse(`${DIFF_SCHEME}:${newKey}`);
        const title = `Review: ${op.uri}`;

        await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, {
          preview: true,
        });
      }

      // Ask via the in-chat approval card (cannot be accidentally dismissed).
      const approved = await this._requestApproval(
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
        this._diffProvider.delete(oldKey);
        this._diffProvider.delete(newKey);
      }

      this._log.appendLine(`[edit] user answered: ${approved ? 'Apply' : 'Deny'} for ${op.uri}`);
      if (!approved) {
        this._postMessage({ type: 'status', text: `Edit cancelled: ${op.uri}` });
        this._postMessage({ type: 'editResult', uri: op.uri, outcome: 'cancelled' });
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
      this._log.appendLine(`[edit] applied: ${op.uri}`);
      this._postMessage({ type: 'status', text: `Applied: ${op.uri}` });
      this._postMessage({ type: 'editResult', uri: op.uri, outcome: 'applied' });
    }
  }

  /**
   * Parse @@RUN blocks from the assistant response, request approval for each,
   * execute approved commands, and append a summary back into the conversation
   * so the model can see the output.
   */
  private async _processRunBlocks(assistantText: string): Promise<void> {
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
      const approved = await this._requestApproval(
        'runCommand',
        { command: block.command },
        'The assistant wants to run a terminal command.'
      );

      if (!approved) {
        this._postMessage({ type: 'status', text: `Command cancelled: ${block.command}` });
        resultLines.push(`<RUN_RESULT command="${block.command}" status="cancelled by user"/>`);
        continue;
      }

      this._postMessage({ type: 'status', text: `Running: ${block.command}` });
      const result = await runCommand(block.command, cwd);
      const summary = formatRunResult(result);
      resultLines.push(summary);

      const statusText = result.timedOut
        ? `Timed out: ${block.command}`
        : `Done (exit ${result.exitCode ?? '?'}): ${block.command}`;
      this._postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this._history.push({ role: 'user', content: feedbackContent });
    this._saveCurrentSession();
  }

  /**
   * Parse @@MOVE blocks from the assistant response, request approval for each,
   * execute approved moves, and append a summary back into the conversation
   * so the model can see the result.
   */
  private async _processMoveBlocks(assistantText: string): Promise<void> {
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
        this._postMessage({ type: 'status', text: msg });
        resultLines.push(`<MOVE_RESULT from="${block.from}" to="${block.to}" status="failed" error="${msg}"/>`);
        continue;
      }

      if (!toAbsolute) {
        const msg = `Move blocked: destination path "${block.to}" is outside the workspace.`;
        this._postMessage({ type: 'status', text: msg });
        resultLines.push(`<MOVE_RESULT from="${block.from}" to="${block.to}" status="failed" error="${msg}"/>`);
        continue;
      }

      const approved = await this._requestApproval(
        'moveFile',
        { from: block.from, to: block.to },
        'The assistant wants to move a file.'
      );

      if (!approved) {
        this._postMessage({ type: 'status', text: `Move cancelled: ${block.from} → ${block.to}` });
        resultLines.push(`<MOVE_RESULT from="${block.from}" to="${block.to}" status="cancelled by user"/>`);
        continue;
      }

      this._postMessage({ type: 'status', text: `Moving: ${block.from} → ${block.to}` });
      const result = await moveFile(fromAbsolute, toAbsolute);
      const summary = formatMoveResult(result);
      resultLines.push(summary);

      const statusText = result.success
        ? `Moved: ${block.from} → ${block.to}`
        : `Move failed: ${result.error}`;
      this._postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this._history.push({ role: 'user', content: feedbackContent });
    this._saveCurrentSession();
  }

  /**
   * Parse @@DELETE blocks from the assistant response, request approval for each,
   * execute approved deletions (to trash), and append a summary back into the
   * conversation so the model can see the result.
   */
  private async _processDeleteBlocks(assistantText: string): Promise<void> {
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
        this._postMessage({ type: 'status', text: msg });
        resultLines.push(`<DELETE_RESULT path="${block.filePath}" status="failed" error="${msg}"/>`);
        continue;
      }

      const approved = await this._requestApproval(
        'deleteFile',
        { path: block.filePath },
        'The assistant wants to delete a file (will be moved to trash).'
      );

      if (!approved) {
        this._postMessage({ type: 'status', text: `Delete cancelled: ${block.filePath}` });
        resultLines.push(`<DELETE_RESULT path="${block.filePath}" status="cancelled by user"/>`);
        continue;
      }

      this._postMessage({ type: 'status', text: `Deleting: ${block.filePath}` });
      const result = await deleteFile(fileAbsolute);
      const summary = formatDeleteResult(result);
      resultLines.push(summary);

      const statusText = result.success
        ? `Deleted (trashed): ${block.filePath}`
        : `Delete failed: ${result.error}`;
      this._postMessage({ type: 'status', text: statusText });
    }

    if (resultLines.length === 0) {
      return;
    }

    // Feed results back to the model as a user message so it can continue.
    const feedbackContent = resultLines.join('\n\n');
    this._history.push({ role: 'user', content: feedbackContent });
    this._saveCurrentSession();
  }

  /**
   * Send an `approval/request` to the webview and wait for the user's
   * `approval/response`. Returns `true` if approved, `false` if cancelled.
   */
  private _requestApproval(action: string, payload: unknown, reason = ''): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const approvalId = `approval-${++this._approvalCounter}`;
      this._approvalResolvers.set(approvalId, resolve);
      this._postMessage({ type: 'approval/request', approvalId, action, payload, reason });
    });
  }

  private _handleMessage(message: WebviewToExtension): void {
    switch (message.type) {
      case 'send':
        this._thinkingMode = message.thinkingMode ?? false;
        this._includeAgentsMd = message.includeAgentsMd ?? false;
        this._handleSend(message.prompt).catch((err) => {
          this._postMessage({ type: 'error', message: String(err) });
          this._abortController = undefined;
        });
        break;
      case 'stop':
        this._userCancelled = true;
        this._abortController?.abort();
        this._abortController = undefined;
        // Reject any approval cards that are still pending
        for (const [id, resolve] of this._approvalResolvers) {
          this._approvalResolvers.delete(id);
          resolve(false);
        }
        this._postMessage({ type: 'done', cancelled: true });
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'attachFiles':
        this._handleAttachFiles().catch((err) => {
          this._postMessage({ type: 'error', message: String(err) });
        });
        break;
      case 'attachActiveEditor':
        this._handleAttachActiveEditor().catch((err) => {
          this._postMessage({ type: 'error', message: String(err) });
        });
        break;
      case 'selectSession':
        this._handleSelectSession().catch((err) => {
          this._postMessage({ type: 'error', message: String(err) });
        });
        break;
      case 'approval/response': {
        const resolver = this._approvalResolvers.get(message.approvalId);
        if (resolver) {
          this._approvalResolvers.delete(message.approvalId);
          resolver(message.approved);
        }
        break;
      }
      case 'checkboxChange':
        // Update internal state when checkbox is toggled (without sending a message)
        if (message.includeAgentsMd !== undefined) {
          this._includeAgentsMd = message.includeAgentsMd;
          this._saveCurrentSession();
        }
        break;
    }
  }

  private async _handleAttachFiles(): Promise<void> {
    await vscode.commands.executeCommand('agentic.attachFiles');
  }

  private async _handleAttachActiveEditor(): Promise<void> {
    const updated = await readActiveEditor(this._attachedFiles);
    if (updated) {
      this._attachedFiles = updated;
      this._postMessage({ type: 'attachments', files: updated });
      this._saveCurrentSession();
    }
  }

  private async _handleSelectSession(): Promise<void> {
    const sessions = this._configManager.loadAllSessions();
    if (!sessions || sessions.length === 0) {
      this._postMessage({ type: 'status', text: 'No sessions found.' });
      return;
    }

    // Use VS Code's quick pick
    const vscode = await import('vscode');
    const items = sessions.map(s => ({
      label: s.title,
      description: new Date(s.createdAt).toLocaleString(),
      session: s
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a session to restore',
      matchOnDescription: true
    });

    if (selected) {
      this.restoreSession(selected.session);
    }
  }

  private _saveCurrentSession(): void {
    this._currentSession = {
      ...this._currentSession,
      messages: this._history,
      attachments: this._attachedFiles,
      thinkingMode: this._thinkingMode,
      includeAgentsMd: this._includeAgentsMd,
    };
    this._configManager.saveSession(this._currentSession);
  }

  /**
   * Check whether AGENTS.md exists in the first workspace root and notify the webview.
   */
  private async _notifyAgentsMdAvailability(): Promise<void> {
    const wsRoots = vscode.workspace.workspaceFolders ?? [];
    let available = false;
    if (wsRoots.length > 0) {
      const agentsMdUri = vscode.Uri.joinPath(wsRoots[0].uri, 'AGENTS.md');
      try {
        await vscode.workspace.fs.stat(agentsMdUri);
        available = true;
      } catch {
        available = false;
      }
    }
    this._postMessage({ type: 'agentsMdAvailable', available });
  }

  /**
   * Push the current session's conversation history and attachments back into
   * the webview so the UI reflects a restored session after a VS Code restart.
   */
  private _restoreSessionUi(): void {
    // Send the current editor state
    this._postMessage({ type: 'editorState', hasActiveEditor: this._hasActiveEditor });
    // Send checkbox states so the UI reflects the restored session
    this._postMessage({ type: 'checkboxState', thinkingMode: this._thinkingMode, includeAgentsMd: this._includeAgentsMd });

    if (this._attachedFiles.length > 0) {
      this._postMessage({ type: 'attachments', files: this._attachedFiles });
    }
    if (this._history.length > 0) {
      // Replay the conversation as a series of delta messages followed by done,
      // so the existing output area rendering logic is reused without changes.
      for (const msg of this._history) {
        if (msg.role === 'user') {
          const display = msg.displayContent ?? msg.content;
          this._postMessage({ type: 'delta', content: `\n\n**You:** ${display}\n\n---\n\n` });
        } else if (msg.role === 'assistant') {
          this._postMessage({ type: 'delta', content: msg.content });
        }
      }
      this._postMessage({ type: 'done' });
      this._postMessage({ type: 'status', text: 'Session restored.' });
    }
  }

  private _postMessage(message: ExtensionToWebview): void {
    // Handle backpressure: buffer delta messages when webview is hidden
    if (message.type === 'delta' && !this._isViewVisible) {
      this._deltaBuffer.push(message.content);
      return;
    }

    // Flush any buffered deltas before sending non-delta messages
    if (message.type !== 'delta' && this._deltaBuffer.length > 0) {
      this._flushDeltaBuffer();
    }

    this._view?.webview.postMessage(message);
  }

  /**
   * Flush all buffered delta messages to the webview.
   * Called when the webview becomes visible again.
   */
  private _flushDeltaBuffer(): void {
    if (this._deltaBuffer.length === 0) {
      return;
    }

    // Send all buffered deltas as individual messages
    for (const content of this._deltaBuffer) {
      this._view?.webview.postMessage({ type: 'delta', content });
    }

    // Clear the buffer
    this._deltaBuffer = [];
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
  <title>Agent 86</title>
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
