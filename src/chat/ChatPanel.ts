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
  parseSearchRequests, formatSearchResultBlock, searchFileWithRg,
  extractPromptTokens, selectBestChunk, selectExactLineRangeChunks,
  FileChunkMeta, FileChunk, ChunkRequest,
} from '../tools/ChunkManager';
import { parseRunBlocks, runCommand, formatRunResult } from '../tools/TerminalTool';
import { parseMoveBlocks, resolveMoveBlockPath, moveFile, formatMoveResult } from '../tools/MoveFileTool';
import { parseDeleteBlocks, resolveDeleteBlockPath, deleteFile, formatDeleteResult } from '../tools/DeleteFileTool';
import { ConfigManager, Session } from '../config/ConfigManager';
import { TokenCounter } from '../tools/TokenCounter';

const DIFF_SCHEME = 'agentic-diff';

/** Normalize common incorrect file extensions in glob patterns. */
function normalizeGlob(glob: string): string {
  return glob
    .replace(/\bc#\b/g, 'cs')     // C# → cs
    .replace(/\bc\+\+\b/g, 'cpp') // C++ → cpp
    .replace(/\bf#\b/g, 'fs');    // F# → fs
}

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
  private readonly _tokenCounter: TokenCounter;

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

    this._tokenCounter = new TokenCounter(context.globalStorageUri.fsPath, log);
    this._reloadTokenizer();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('agent86.tokenizerModel')) {
          this._reloadTokenizer();
        }
      })
    );

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

    const version = this.context.extension.packageJSON.version as string;
    webviewView.title = `v${version}`;

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
      vscode.commands.executeCommand('agent86.panel.focus');
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
   * Resolve a workspace-relative path to an absolute path, with a
   * case-insensitive basename glob fallback if the exact path doesn't exist.
   * Returns { absolutePath, relativePath } or null if unresolvable.
   */
  private async _resolvePathWithFallback(
    relativePath: string,
    wsRoots: string[]
  ): Promise<{ absolutePath: string; relativePath: string } | null> {
    const pathResult = resolveEditPath(relativePath, wsRoots);
    if (!pathResult.error) {
      // Check it actually exists on disk
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(pathResult.resolvedPath!));
        return { absolutePath: pathResult.resolvedPath!, relativePath };
      } catch { /* fall through to glob */ }
    }

    // Glob fallback: match by basename (case-insensitive)
    const basename = path.basename(relativePath);
    const basenameLower = basename.toLowerCase();
    let uris: vscode.Uri[] = [];
    try { uris = await vscode.workspace.findFiles(`**/${basename}`, FILE_EXCLUDE_GLOB, 10); } catch { /* ignore */ }
    if (uris.length === 0) {
      try {
        const all = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE_GLOB, 500);
        uris = all.filter(u => path.basename(u.fsPath).toLowerCase() === basenameLower);
      } catch { /* ignore */ }
    }
    if (uris.length === 1) {
      const wsRoot = wsRoots[0] ?? '';
      const abs = uris[0].fsPath;
      const rel = abs.startsWith(wsRoot + path.sep)
        ? abs.slice(wsRoot.length + 1).replace(/\\/g, '/')
        : abs.replace(/\\/g, '/');
      this._log.appendLine(`[resolve] "${relativePath}" → "${rel}" via glob fallback`);
      return { absolutePath: abs, relativePath: rel };
    }
    return null;
  }

  /**
   * Read, chunk, and cache metadata for a single file.
   * Returns the chunks array, or null if the file cannot be read.
   */
  private async _getChunksForUri(
    relativePath: string,
    wsRoots: string[]
  ): Promise<FileChunk[] | null> {
    const resolved = await this._resolvePathWithFallback(relativePath, wsRoots);
    if (!resolved) {
      this._log.appendLine(`[chunks] could not read "${relativePath}" — file not found or outside workspace`);
      return null;
    }

    const { absolutePath, relativePath: resolvedRelativePath } = resolved;
    const fileUri = vscode.Uri.file(absolutePath);
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
        this._log.appendLine(`[chunks] could not read "${relativePath}"`);
        return null;
      }
    }

    const chunks = chunkFile(resolvedRelativePath, content, docVersion);
    this._chunkMeta.set(resolvedRelativePath, buildChunkMeta(chunks));
    return chunks;
  }

  /**
   * Select chunks to fulfil a `request_chunks` request.
   * Supports either:
   * - `preferred.line_range` (exact inclusive lines, no overlap padding), or
   * - `preferred.near_line` (chunk window around a line).
   * Defaults to first N chunks.
   */
  private _selectChunksForRequest(
    chunks: FileChunk[],
    preferred?: ChunkRequest['preferred']
  ): FileChunk[] {
    const maxChunks = preferred?.max_chunks ?? 2;
    const lineRange = preferred?.line_range;
    if (lineRange) {
      return selectExactLineRangeChunks(chunks, lineRange, maxChunks);
    }
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

  private _reloadTokenizer(): void {
    const cfg = vscode.workspace.getConfiguration('agent86');
    const modelId = cfg.get<string>('tokenizerModel')?.trim() ?? '';
    if (modelId) {
      this._tokenCounter.load(modelId);
    }
  }

  private _getProvider(): OpenAIProvider {
    const cfg = vscode.workspace.getConfiguration('agent86');
    const baseUrl = cfg.get<string>('baseUrl') ?? 'http://127.0.0.1:8083/v1';
    const model = cfg.get<string>('model') ?? 'gpt-3.5-turbo';
    const apiKey = cfg.get<string>('apiKey') ?? 'local';
    return new OpenAIProvider(baseUrl, model, apiKey, this._log);
  }

  private _estimateMessageChars(messages: ChatMessage[]): number {
    // Rough char-based budget; keeps this logic fast and dependency-free.
    return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  }

  /**
   * Compress large tool blocks in older history so sessions stay small.
   * Keeps head+tail so tags remain visible.
   */
  private _summarizeToolHeavyMessage(content: string): string {
    const HEAD = 3000;
    const TAIL = 500;
    if (content.length <= HEAD + TAIL + 200) {
      return content;
    }
    const head = content.slice(0, HEAD);
    const tail = content.slice(-TAIL);
    return `${head}\n\n... [history truncated] ...\n\n${tail}`;
  }

  private _looksLikeToolPayload(content: string): boolean {
    return (
      content.includes('<search_result') ||
      content.includes('<file_list') ||
      content.includes('<file_chunk') ||
      content.includes('<RUN_RESULT') ||
      content.includes('<MOVE_RESULT') ||
      content.includes('<DELETE_RESULT')
    );
  }

  /**
   * Mutate stored history: summarize older tool payloads so the persisted session
   * doesn't keep growing indefinitely.
   */
  private _compactHistoryInPlace(): void {
    const KEEP_LAST = 4;
    const MAX_RAW_LEN = 4500;
    for (let i = 0; i < Math.max(0, this._history.length - KEEP_LAST); i++) {
      const m = this._history[i];
      if (m.role !== 'user') {
        continue;
      }
      if (!m.content || m.content.length < MAX_RAW_LEN) {
        continue;
      }
      if (!this._looksLikeToolPayload(m.content)) {
        continue;
      }
      this._history[i] = { ...m, content: this._summarizeToolHeavyMessage(m.content) };
    }
  }

  /** Trim the message list by dropping oldest turns (after system) until under budget. */
  private _trimMessagesToBudget(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
    if (messages.length <= 2) {
      return messages;
    }

    const KEEP_AT_LEAST = 3; // system + last user + last assistant (when present)
    let total = this._estimateMessageChars(messages);

    const trimmed = [...messages];
    while (total > budgetChars && trimmed.length > KEEP_AT_LEAST) {
      // Drop the oldest non-system message.
      const removed = trimmed.splice(1, 1)[0];
      total -= removed?.content?.length ?? 0;
    }

    if (total > budgetChars && trimmed.length === KEEP_AT_LEAST) {
      // Still too big: hard-truncate the oldest remaining non-system message.
      const idx = 1;
      const sysLen = trimmed[0]?.content?.length ?? 0;
      const tailLen = (trimmed[2]?.content?.length ?? 0) + (trimmed[1]?.content?.length ?? 0);
      const remaining = Math.max(0, budgetChars - sysLen - (trimmed[2]?.content?.length ?? 0));
      if (trimmed[idx]?.content && remaining > 0) {
        trimmed[idx] = {
          ...trimmed[idx],
          content: trimmed[idx].content.slice(0, remaining) + '\n\n... [truncated to fit context budget] ...',
        };
      }
    }

    return trimmed;
  }

  private _buildMessages(agentsMdContent?: string): ChatMessage[] {
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
Files arrive as \`<file_chunk path uri chunk_id lines total_chunks doc_version hash>\` blocks. You may only receive the first chunk initially. When \`<resolved_paths>\` is present, use those exact paths in \`search_file\` and \`request_chunks\` URIs.

## Requesting data
Before any file search, resolve workspace-relative paths and confirm existence.

Emit ONE of these JSON objects instead of \`edits\` (max 2 rounds each; do not combine with \`edits\` or each other):

**Search file:** \`{"search_file":[{"uri":"src/foo.ts","pattern":"MyImport","case_sensitive":false,"reason":"…"}]}\` → returns \`<search_result uri pattern case_sensitive count>\` with each hit plus nearby context lines. Omit \`case_sensitive\` or set \`true\` for exact-case matching; set \`false\` when case may vary. Use this to find identifier usages across a whole file without reading every chunk. **Prefer this over requesting more chunks when you need to verify whether something is used.**

**More chunks:** \`{"request_chunks":[{"uri":"src/foo.ts","reason":"…","preferred":{"near_line":250,"max_chunks":2}}]}\` or \`{"request_chunks":[{"uri":"src/foo.ts","reason":"…","preferred":{"line_range":{"start":45,"end":90},"max_chunks":2}}]}\`. Use \`line_range\` when you need exact lines. Keep \`max_chunks\` small (1–2); the context window is limited.

For questions about symbol usage (for example: "is this import unused?", references, call-sites), use \`search_file\` first and search the whole file with ripgrep. Do not use \`request_chunks\` to discover usages; only request chunks after search when exact surrounding code is still required.

**File listing:** \`{"request_files":[{"glob":"src/**/*","reason":"…"}]}\` → returns \`<file_list glob count>paths…</file_list>\`. Be specific with globs (e.g. \`**/*.cs\`, \`src/**/*.py\`); \`node_modules\`, \`.git\`, \`dist\`, \`build\` are excluded. Use correct extensions: \`cs\` for C#, \`cpp\` for C++, \`fs\` for F# (not \`c#\`, \`c++\`, \`f#\`).

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

    // Keep the sendable context small (models/servers often have hard 32KB-ish limits).
    const CONTEXT_BUDGET_CHARS = 30_000;

    // For send-only: summarize older tool payloads; keep the most recent few messages verbatim.
    const KEEP_LAST_VERBOSE = 6;
    const historyForSend = this._history.map((m, idx) => {
      const fromEnd = this._history.length - idx;
      if (fromEnd <= KEEP_LAST_VERBOSE) {
        return m;
      }
      if (m.role === 'user' && m.content && m.content.length > 4500 && this._looksLikeToolPayload(m.content)) {
        return { ...m, content: this._summarizeToolHeavyMessage(m.content) };
      }
      return m;
    });

    const rawMessages = [systemPrompt, ...historyForSend];
    const messages = this._trimMessagesToBudget(rawMessages, CONTEXT_BUDGET_CHARS);

    this._log.appendLine(`[buildMessages] ${messages.length} message(s), thinkingMode=${this._thinkingMode}`);
    this._log.appendLine(`[buildMessages] approxChars=${this._estimateMessageChars(messages)}/${CONTEXT_BUDGET_CHARS}`);
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
    const previouslyAttachedUris = new Set(this._attachedFiles.map(f => f.uri));
    const autoAttached = await autoDetectAndAttachFiles(prompt, this._attachedFiles);
    const autoDetectedThisTurnUris = new Set(
      autoAttached
        .filter(f => !previouslyAttachedUris.has(f.uri))
        .map(f => f.uri)
    );
    this._log.appendLine(`[autoAttach] before=${this._attachedFiles.length} after=${autoAttached.length}`);
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

      // Cap how much attachment context we inject into the initial user message.
      const MAX_INJECTED_CHARS = 18_000;
      let injectedChars = 0;
      const resolvedPaths: string[] = [];

      for (const f of newFiles) {
        if (injectedChars >= MAX_INJECTED_CHARS) {
          this._log.appendLine(`[chunks] injection cap reached (${MAX_INJECTED_CHARS} chars) — skipping remaining attached files`);
          break;
        }

        const chunks = await this._getChunksForUri(f.relativePath, wsRoots);
        let block: string | null = null;

        if (chunks && chunks.length > 0) {
          if (autoDetectedThisTurnUris.has(f.uri)) {
            const absolutePath = path.join(wsRoot, f.relativePath);
            this._postMessage({ type: 'status', text: `Searching ${f.relativePath}…` });
            const best = await selectBestChunk(chunks, absolutePath, promptTokens);
            block = formatChunkBlock(best);
            initialChunkIds.push(best.chunkId);
            this._log.appendLine(`[chunks] sending ${best.uri} lines ${best.lineStart}-${best.lineEnd} (rg-scored, total=${best.totalChunks})`);
          } else {
            const first = chunks[0];
            block = formatChunkBlock(first);
            initialChunkIds.push(first.chunkId);
            this._log.appendLine(`[chunks] sending ${first.uri} lines ${first.lineStart}-${first.lineEnd} (manual attach, initial=1, total=${first.totalChunks})`);
          }
        } else {
          // Fallback for unreadable/unsaved files
          block = `<file path="${f.relativePath}" language="${f.languageId}">\n${f.content}\n</file>`;
        }

        if (!block) {
          continue;
        }

        if (injectedChars + block.length > MAX_INJECTED_CHARS) {
          this._log.appendLine(`[chunks] skipping ${f.relativePath} — would exceed injection cap (${MAX_INJECTED_CHARS} chars)`);
          break;
        }

        chunkBlocks.push(block);
        injectedChars += block.length;
        resolvedPaths.push(`  - ${f.relativePath}`);
        this._injectedFileUris.add(f.uri);
      }

      if (chunkBlocks.length > 0) {
        this._postMessage({ type: 'status', text: `Sending chunks for ${chunkBlocks.length} file(s)…` });
        // Append resolved paths so the model uses exact URIs in search_file / request_chunks
        const pathNote = resolvedPaths.join('\n');
        userContent = `${chunkBlocks.join('\n\n')}\n\n${prompt}` +
          `\n\n<resolved_paths>\n${pathNote}\n</resolved_paths>` +
          (newFiles.length > chunkBlocks.length ? `\n\n<context_note>Attachment context capped to stay within budget.</context_note>` : '');
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

    const MAX_FILE_ROUNDS = 4;
    let fileRound = 0;

    // Chunk requests are often iterative (line_range tweaks, follow-up context).
    // Allow a bit more headroom than searches, but still keep a hard cap.
    const MAX_CHUNK_ROUNDS = 6;
    let chunkRound = 0;
    // If the model keeps requesting chunks we can't provide (bad path / outside workspace / already sent),
    // don't burn a real chunk round, but also don't allow infinite loops.
    const MAX_CHUNK_NOOP_ROUNDS = 3;
    let chunkNoOpRounds = 0;

    const MAX_SEARCH_ROUNDS = 4;
    let searchRound = 0;
    const MAX_SEARCH_FIRST_REDIRECTS = 2;
    let searchFirstRedirects = 0;
    const enforceSearchFirst = /\b(unused|usage|used|reference|references|import|call[- ]?site|where\s+used)\b/i.test(prompt);
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
        const messages = this._buildMessages(agentsMdContent);
        const contextTokens = await this._tokenCounter.countMessages(messages);
        const exact = this._tokenCounter.isReady;
        this._postMessage({ type: 'status', text: `Sending ${exact ? '' : '~'}${contextTokens.toLocaleString()} tokens…` });
        await provider.stream(
          messages,
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
          },
          { chat_template_kwargs: { enable_thinking: this._thinkingMode } }
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
            const normalizedGlob = normalizeGlob(req.glob);
            if (normalizedGlob !== req.glob) {
              this._log.appendLine(`[files] normalized glob "${req.glob}" → "${normalizedGlob}"`);
            }
            this._log.appendLine(`[files] glob="${normalizedGlob}" reason="${req.reason ?? ''}"`);
            let uris: vscode.Uri[] = [];
            try { uris = await vscode.workspace.findFiles(normalizedGlob, FILE_EXCLUDE_GLOB, 200); }
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

        // Check if the model is requesting file searches
         const searchRequests = parseSearchRequests(fullResponse);
         if (searchRequests && searchRound < MAX_SEARCH_ROUNDS) {
           searchRound++;

           // Hard cap: avoid a model asking for many searches and inflating the next request.
           const MAX_SEARCH_REQUESTS_PER_ROUND = 2;
           const effectiveSearchRequests = searchRequests.slice(0, MAX_SEARCH_REQUESTS_PER_ROUND);
           const capped = effectiveSearchRequests.length !== searchRequests.length;

           this._log.appendLine(
             `[search] round ${searchRound}/${MAX_SEARCH_ROUNDS}, ${effectiveSearchRequests.length}/${searchRequests.length} request(s)` +
             (capped ? ' (capped)' : '')
           );
           this._postMessage({ type: 'status', text: `Searching ${effectiveSearchRequests.length} file(s)…` });

           const parts: string[] = [];
           for (const req of effectiveSearchRequests) {
              const caseSensitive = req.caseSensitive ?? true;
              const isGlob = /[*?{]/.test(req.uri);
              let absolutePath: string;
              let displayUri: string;
              let globFilter: string | undefined;
              if (isGlob) {
                // Extract the non-glob prefix directory (e.g. "src/**/*" → "src", "backend/**/*" → "backend")
                const slashIdx = req.uri.search(/[*?{]/);
                const prefix = req.uri.slice(0, slashIdx).replace(/[\\/]+$/, '');
                const wsRoot = wsRoots[0] ?? '';
                absolutePath = prefix ? path.join(wsRoot, prefix) : wsRoot;
                // Verify the directory exists; fall back to workspace root
                try { await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath)); }
                catch { absolutePath = wsRoot; }
                // Only pass --glob if the pattern specifies a file extension filter (e.g. src/**/*.ts).
                // For generic patterns like src/**/* the directory root alone is sufficient.
                globFilter = /\.\w+$/.test(req.uri) ? req.uri : undefined;
                displayUri = req.uri;
              } else {
                const resolved = await this._resolvePathWithFallback(req.uri, wsRoots);
                absolutePath = resolved?.absolutePath ?? path.join(wsRoots[0] ?? '', req.uri);
                displayUri = resolved?.relativePath ?? req.uri;
              }

              // Directory-wide searches can produce huge ripgrep output and hit the 96KB stdout cap.
              // Apply a conservative default file glob unless the model already supplied one.
              if (!globFilter) {
                try {
                  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
                  if (stat.type === vscode.FileType.Directory) {
                    globFilter = '**/*.{ts,tsx,js,jsx,mjs,cjs,cs,py,java,kt,go,rs,cpp,c,h,hpp,fs,fsx}';
                    this._log.appendLine(`[search] default globFilter applied for directory search: ${globFilter}`);
                  }
                } catch {
                  // ignore
                }
              }

              const { lines: matches, matchCount, error: searchError } = await searchFileWithRg(
                absolutePath,
                req.pattern,
                caseSensitive,
                globFilter
              );
if (searchError) {
               this._log.appendLine(`[search] rg error for "${displayUri}": ${searchError}`);
             }
             this._log.appendLine(
               `[search] "${req.pattern}" in ${displayUri} (${absolutePath})` +
               ` [case_sensitive=${caseSensitive}] → ${matchCount} match(es)` +
               `${searchError ? ' (error)' : ''}`
             );
             parts.push(formatSearchResultBlock(displayUri, req.pattern, matches, matchCount, searchError, caseSensitive));
           }

           if (capped) {
             parts.push(
               `<tool_note>Search requests capped to ${MAX_SEARCH_REQUESTS_PER_ROUND} per round to stay within context budget.</tool_note>`
             );
           }

           this._history.push({ role: 'user', content: parts.join('\n\n') });
           continue;
         }
if (searchRequests) {
          this._log.appendLine(`[search] retry limit reached`);
          this._postMessage({ type: 'status', text: 'Search request limit reached.' });
          // Don't break yet - let the model provide its final response with what it has
          finalResponse = fullResponse;
          break;
        }

        // Check if the model is requesting more file chunks
        const chunkRequests = parseChunkRequests(fullResponse);
        if (
          chunkRequests &&
          enforceSearchFirst &&
          !searchRequests &&
          searchRound < MAX_SEARCH_ROUNDS &&
          searchFirstRedirects < MAX_SEARCH_FIRST_REDIRECTS
        ) {
          searchFirstRedirects++;
          this._log.appendLine(
            `[chunks] redirect ${searchFirstRedirects}/${MAX_SEARCH_FIRST_REDIRECTS}:` +
            ' usage/import query should use search_file before request_chunks'
          );
          this._history.push({
            role: 'user',
            content:
              '<tool_guidance>For usage/import/reference checks, use local ripgrep via search_file first.' +
              ' Request chunks only after search hits if exact surrounding code is still needed.</tool_guidance>',
          });
          continue;
        }

        if (chunkRequests) {
          if (chunkRound >= MAX_CHUNK_ROUNDS) {
            // Hard limit reached while model still wants more.
            this._log.appendLine(`[chunks] retry limit reached`);
            this._postMessage({ type: 'status', text: 'Chunk request limit reached. Try attaching more of the file manually.' });
            finalResponse = fullResponse;
            break;
          }

          this._log.appendLine(
            `[chunks] model requested ${chunkRequests.length} chunk(s), round ${chunkRound + 1}/${MAX_CHUNK_ROUNDS}`
          );
          this._postMessage({ type: 'status', text: `Fetching ${chunkRequests.length} requested chunk(s)…` });

          const parts: string[] = [];
          for (const req of chunkRequests) {
            const chunks = await this._getChunksForUri(req.uri, wsRoots);
            if (!chunks) {
              this._log.appendLine(`[chunks] could not read "${req.uri}" — skipping`);
              // Do not count this as a successful chunk delivery.
              continue;
            }

            const maxNew = req.preferred?.max_chunks ?? 2;
            let newSent = 0;
            const selected = this._selectChunksForRequest(chunks, req.preferred);
            if (req.preferred?.line_range) {
              const { start, end } = req.preferred.line_range;
              this._log.appendLine(`[chunks] using line_range ${start}-${end} for "${req.uri}"`);
            }

            for (const chunk of selected) {
              if (sentChunkIds.has(chunk.chunkId)) {
                this._log.appendLine(`[chunks] skipping already-sent chunk ${chunk.chunkId}`);
                continue;
              }
              if (newSent >= maxNew) {
                this._log.appendLine(`[chunks] max_chunks cap (${maxNew}) reached for "${req.uri}"`);
                break;
              }
              sentChunkIds.add(chunk.chunkId);
              parts.push(formatChunkBlock(chunk));
              this._log.appendLine(`[chunks] sending ${chunk.uri} lines ${chunk.lineStart}-${chunk.lineEnd} (${chunk.chunkId}, total=${chunk.totalChunks})`);
              newSent++;
            }
          }

          if (parts.length === 0) {
            chunkNoOpRounds++;
            this._log.appendLine(`[chunks] no new chunks to send (noop ${chunkNoOpRounds}/${MAX_CHUNK_NOOP_ROUNDS})`);
            this._postMessage({
              type: 'status',
              text: 'No new chunks to send. Try specifying near_line/line_range or attaching more of the file.',
            });

            if (chunkNoOpRounds >= MAX_CHUNK_NOOP_ROUNDS) {
              // Avoid looping forever; let the model respond with what it has.
              finalResponse = fullResponse;
              break;
            }

            // Give the model another chance to adjust its request (without consuming a chunk round).
            this._history.push({
              role: 'user',
              content:
                '<tool_guidance>No new chunks were available for your request. ' +
                'If you need a different section, request a different near_line/line_range, or provide a workspace-relative URI.</tool_guidance>',
            });
            continue;
          }

          // Successful chunk delivery.
          chunkNoOpRounds = 0;
          chunkRound++;
          this._history.push({ role: 'user', content: parts.join('\n\n') });
          continue; // stream again with expanded context
        }

        if (fullResponse.trimStart().startsWith('{')) {
          this._log.appendLine(`[stream] unrecognized JSON response: ${fullResponse.slice(0, 300)}`);
          // Provide a small, explicit correction so models that default to tool-JSON
          // don't get stuck emitting unparseable/unsupported objects.
          this._history.push({
            role: 'user',
            content:
              '<tool_guidance>Return either plain text OR exactly one of these JSON objects: ' +
              '{"search_file":[{"uri":"path/or/glob","pattern":"...","case_sensitive":false}]}, ' +
              '{"request_files":[{"glob":"**/*.ts","reason":"..."}]}, ' +
              '{"request_chunks":[{"uri":"path","preferred":{"near_line":1,"max_chunks":1}}]}. ' +
              'Do not output other JSON keys.</tool_guidance>',
          });
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
    // Keep persisted history lean: tool outputs (search results, file lists, etc.)
    // can be large and quickly exceed local model/server limits.
    this._compactHistoryInPlace();

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
