import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewToExtension, ExtensionToWebview, AttachedFile } from './messageProtocol';
import { AIProvider } from '../providers/AIProvider';
import { ChatMessage } from '../providers/IProvider';
import { readActiveEditor, autoDetectAndAttachFiles, FILE_EXCLUDE_GLOB, FILE_CAP_BYTES, TOTAL_CAP_BYTES } from '../tools/FileTools';
import { ConfigManager, Session, ProviderConfig } from '../config/ConfigManager';
import { TokenCounter } from '../tools/TokenCounter';
import { DiffContentProvider } from './DiffContentProvider';
import { ChatPanelChunks, AttachedFile as ChunkAttachedFile } from './ChatPanelChunks';
import { ChatPanelEdits } from './ChatPanelEdits';
import { ChatPanelActions } from './ChatPanelActions';
import { ChatPanelSessions } from './ChatPanelSessions';
import { ToolExecutor } from '../tools/ToolExecutor';
import { buildAgentTools } from '../tools/ToolRegistry';
import { ToolCallEvent } from '../providers/IProvider';
import { getSystemPrompt, getNativeToolsPrompt } from '../utils/PromptProcessor';

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _abortController?: AbortController;
  private readonly _log: vscode.OutputChannel;
  /** Set to true when the user explicitly clicks Stop; cleared on new send. */
  private _userCancelled = false;
  /** Tracks which attached file URIs have already been injected into _history. */
  private _injectedFileUris = new Set<string>();
  private readonly _diffProvider = new DiffContentProvider();
  /** Pending approval resolvers keyed by approvalId. */
  private readonly _approvalResolvers = new Map<string, (approved: boolean) => void>();
  private _approvalCounter = 0;
  private readonly _configManager: ConfigManager;
  private readonly _tokenCounter: TokenCounter;

  // Backpressure handling: buffer deltas when webview is hidden
  private _isViewVisible = true;
  private _deltaBuffer: string[] = [];

  // Track active editor state
  private _hasActiveEditor = false;

  // Multi-provider support
  private _activeProviderIndex = 0;

  // Modular components
  private readonly _sessions: ChatPanelSessions;
  private readonly _chunks: ChatPanelChunks;
  private readonly _edits: ChatPanelEdits;
  private readonly _actions: ChatPanelActions;

  constructor(private readonly context: vscode.ExtensionContext, log: vscode.OutputChannel) {
    this._log = log;
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('agentic-diff', this._diffProvider)
    );
    this._configManager = new ConfigManager(context);
    this._activeProviderIndex = this._configManager.getActiveProviderIndex();

    this._tokenCounter = new TokenCounter();

    // Initialize modular components
    this._sessions = new ChatPanelSessions({
      configManager: this._configManager,
      log: this._log,
      postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
    });

    this._chunks = new ChatPanelChunks({
      log: this._log,
      getWorkspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
      postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
    });

    this._edits = new ChatPanelEdits({
      log: this._log,
      diffProvider: this._diffProvider,
      postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
      requestApproval: (action, payload, reason) => this._requestApproval(action, payload, reason),
      pushHistory: (msg) => this._sessions.history.push(msg),
      saveSession: () => this._sessions.saveCurrentSession(),
    });

    this._actions = new ChatPanelActions({
      log: this._log,
      postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
      requestApproval: (action, payload, reason) => this._requestApproval(action, payload, reason),
      pushHistory: (msg) => this._sessions.history.push(msg),
      saveSession: () => this._sessions.saveCurrentSession(),
    });

    // Restore last session, or start a fresh one
    const restored = this._sessions.loadLastSession();
    if (!restored) {
      this._sessions.newSession();
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
    // Reject any pending approval dialogs so their promises settle cleanly
    for (const [id, resolve] of this._approvalResolvers) {
      this._approvalResolvers.delete(id);
      resolve(false);
    }
    this._injectedFileUris = new Set();
    this._chunks.chunkMeta = new Map();
    // Discard any buffered deltas — the webview is about to clear its output
    this._deltaBuffer = [];
    this._sessions.newSession();
    if (this._view) {
      this._postMessage({ type: 'newSession' });
      this._postMessage({ type: 'attachments', files: [] });
      this._postMessage({ type: 'status', text: 'New session started.' });
    } else {
      // Panel not yet open — reveal it; resolveWebviewView will render the empty session
      this.reveal();
    }
  }

  public openSettings(): void {
    const providers = this._getProviders();
    this._postMessage({ type: 'openSettings', providers, activeProviderIndex: this._activeProviderIndex });
  }

  public attachFiles(): void {
    this._handleMessage({ type: 'attachFiles' });
  }

  /**
   * Get the currently attached files (used by the file tree picker).
   */
  public getAttachedFiles(): AttachedFile[] {
    return this._sessions.attachedFiles;
  }

  /**
   * Update the attached files list (used by the file tree picker).
   */
  public updateAttachedFiles(files: AttachedFile[]): void {
    this._sessions.attachedFiles = files;
    this._postMessage({ type: 'attachments', files });
    this._sessions.saveCurrentSession();
  }

  /**
   * Restore a session (used by the quick-pick feature).
   */
  public restoreSession(session: Session): void {
    this._abortController?.abort();
    this._abortController = undefined;
    this._injectedFileUris = new Set(session.attachments.map(f => f.uri));
    this._chunks.chunkMeta = new Map();
    this._sessions.restoreSession(session);
    this._postMessage({ type: 'status', text: `Restored session: ${session.title}` });
    this._restoreSessionUi();
  }

  /**
   * Get the ConfigManager instance (used by quick-pick).
   */
  public getConfigManager(): ConfigManager {
    return this._configManager;
  }

  private _getProviders(): ProviderConfig[] {
    const cfg = vscode.workspace.getConfiguration('agent86');
    const inspected = cfg.inspect<ProviderConfig[]>('providers');
    const globalProviders = inspected?.globalValue;
    
    if (globalProviders && globalProviders.length > 0) {
      return globalProviders;
    }

    // Legacy fallback: build a single provider from old settings
    const baseUrl = cfg.get<string>('baseUrl') ?? 'http://127.0.0.1:8083/v1';
    const model = cfg.get<string>('model') ?? 'gpt-3.5-turbo';
    const apiKey = cfg.get<string>('apiKey') ?? 'local';
    return [{ name: model, baseUrl, model, apiKey, toolUse: true, context: 32768 }];
  }

  private _getProvider(): AIProvider {
    const providers = this._getProviders();
    const idx = Math.min(this._activeProviderIndex, providers.length - 1);
    const providerConfig = providers[idx];
    return new AIProvider(providerConfig, this._log);
  }

  private async _checkProviderHealth(provider: ProviderConfig): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      const baseUrl = provider.baseUrl;

      // Add authentication headers based on provider type
      if (provider.apiKey && provider.apiKey !== 'local') {
        // For OpenRouter and most OpenAI-compatible providers
        headers['Authorization'] = `Bearer ${provider.apiKey}`;

        // OpenRouter requires additional headers
        if (baseUrl.toLowerCase().includes('openrouter.ai')) {
          headers['HTTP-Referer'] = 'https://agent86.darcy.dev';
          headers['X-Title'] = 'Agent 86';
        }
      }

      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        headers,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private _estimateMessageChars(messages: ChatMessage[]): number {
    // Rough char-based budget; keeps this logic fast and dependency-free.
    return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  }

  private _createSystemPrompt(agentsMdContent?: string): string {
    const thinkingMode = this._sessions.thinkingMode;
    const behaviorInstructions = thinkingMode
      ? `Deliberate before acting. When done, briefly summarize what changed (and why if not obvious).`
      : `Act without preamble. No planning narration; no repetition. Afterward: one brief confirmation or nothing.`;
    const agentsMdSection = agentsMdContent
      ? `\n\n## AGENTS.md\n${agentsMdContent}`
      : '';

    // Try to load system prompt from prompts/system-prompt.md with dynamic system info injection
    const customSystemPrompt = getSystemPrompt();

    // throw a warning if system prompt not found
    if (!customSystemPrompt) {
      console.warn('** Custom system prompt not found, using fallback prompts.');
    }

    // Keep one stable system prompt for the entire turn/session, even if the runtime
    // path falls back from native tool-calling to legacy parsing behavior.
    if (customSystemPrompt) {
      return `${customSystemPrompt.trim()}${agentsMdSection}\n\n${behaviorInstructions}`;
    }

    return getNativeToolsPrompt(agentsMdSection, behaviorInstructions);
  }

  private _buildMessages(agentsMdContent?: string, useNativeTools = false): ChatMessage[] {
    const thinkingMode = this._sessions.thinkingMode;
    const systemPrompt: ChatMessage = {
      role: 'system',
      content: this._sessions.getOrCreateSystemPrompt(() => this._createSystemPrompt(agentsMdContent)),
    };

    // Strict append-only context: always resend the exact stored history in order.
    // No per-request history sanitization/rewriting here.
    const messages = [systemPrompt, ...this._sessions.history];
    this._log.appendLine(
      `[buildMessages] ${messages.length} message(s), thinkingMode=${thinkingMode}, nativeTools=${useNativeTools}, appendOnlyHistory=true`
    );
    this._log.appendLine(`[buildMessages] approxChars=${this._estimateMessageChars(messages)}`);
    for (const m of messages) {
      const preview = m.content.slice(0, 120).replace(/\n/g, '↵');
      this._log.appendLine(`  [${m.role}] ${preview}${m.content.length > 120 ? `… (${m.content.length} chars)` : ''}`);
    }

    return messages;
  }

  /**
   * Build provider-specific extra body settings while keeping cross-provider safety.
   * For local llama.cpp-style OpenAI endpoints, send cache hints so repeated turns
   * can reuse KV state when prompts are append-only.
   */
  private _buildExtraBody(provider: ProviderConfig | undefined): Record<string, unknown> {
    const body: Record<string, unknown> = {
      chat_template_kwargs: { enable_thinking: this._sessions.thinkingMode }
    };

    if (!provider) {
      return body;
    }

    try {
      const url = new URL(provider.baseUrl);
      const host = url.hostname.toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
      if (!isLocalHost) {
        return body;
      }

      // Stable slot per session maximizes prompt cache reuse on llama.cpp server.
      const sessionId = this._sessions.currentSession.sessionId;
      let hash = 0;
      for (let i = 0; i < sessionId.length; i++) {
        hash = ((hash * 31) + sessionId.charCodeAt(i)) >>> 0;
      }
      body.cache_prompt = true;
      body.id_slot = Number(hash % 32);
    } catch {
      // Invalid URL or unsupported target — keep generic body only.
    }

    return body;
  }

  /**
   * Detect legacy action syntax in assistant text responses (JSON edits/XML tags).
   * Used as a compatibility fallback when a native-tool model emits legacy format.
   */
  private _looksLikeLegacyActionOutput(content: string): boolean {
    const trimmed = content.trimStart();
    if (/^```(?:json|xml)?\s*\n/i.test(trimmed)) {
      return true;
    }
    if (trimmed.startsWith('{')) {
      return (
        trimmed.includes('"edits"') ||
        trimmed.includes('"request_chunks"') ||
        trimmed.includes('"request_files"') ||
        trimmed.includes('"search_file"')
      );
    }
    return (
      trimmed.includes('<RUN>') ||
      trimmed.includes('<MOVE>') ||
      trimmed.includes('<DELETE>')
    );
  }

  /** Compact single-line preview for debug logs. */
  private _previewForLog(content: string, maxLen = 300): string {
    const singleLine = content.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLen) {
      return singleLine;
    }
    return `${singleLine.slice(0, maxLen)}...`;
  }

  /**
   * Compact oversized tool outputs before adding them to model history.
   * This keeps iterative tool loops responsive and avoids ballooning context.
   */
  private _compactToolResultForHistory(toolName: string, result: string): string {
    const strictTools = new Set(['find_files', 'list_directory', 'search_file_contents']);
    const maxChars = strictTools.has(toolName) ? 6000 : 12000;
    if (result.length <= maxChars) {
      return result;
    }

    const lines = result.split(/\r?\n/);
    const headLines = strictTools.has(toolName) ? 120 : 180;
    const tailLines = strictTools.has(toolName) ? 24 : 36;
    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');
    const omittedLines = Math.max(0, lines.length - headLines - tailLines);
    const omittedChars = Math.max(0, result.length - (head.length + tail.length));

    const compacted =
      `${head}\n` +
      `[... truncated ${omittedLines} line(s), ${omittedChars} char(s) ...]\n` +
      `${tail}`;

    if (compacted.length <= maxChars) {
      return compacted;
    }

    const half = Math.floor((maxChars - 120) / 2);
    return (
      `${result.slice(0, half)}\n` +
      `[... truncated ${result.length - (half * 2)} char(s) ...]\n` +
      `${result.slice(result.length - half)}`
    );
  }

  private async _handleSend(prompt: string): Promise<void> {
    if (this._abortController) {
      // Already generating — ignore duplicate sends
      return;
    }
    this._userCancelled = false;

    // Auto-detect file references in the prompt and attach them before sending
    const previouslyAttachedUris = new Set(this._sessions.attachedFiles.map(f => f.uri));
    const autoAttachResult = await autoDetectAndAttachFiles(prompt, this._sessions.attachedFiles);
    const autoAttached = autoAttachResult.files;
    const autoAttachReport = autoAttachResult.report;

    const autoDetectedThisTurnUris = new Set(
      autoAttached
        .filter(f => !previouslyAttachedUris.has(f.uri))
        .map(f => f.uri)
    );

    this._log.appendLine(`[autoAttach] before=${this._sessions.attachedFiles.length} after=${autoAttached.length}`);
    if (autoAttached.length > this._sessions.attachedFiles.length) {
      this._sessions.attachedFiles = autoAttached;
      this._postMessage({ type: 'attachments', files: this._sessions.attachedFiles });
    }

    // Surface auto-attach skips in-chat (not just as VS Code toasts)
    if (autoAttachReport.skipped.length > 0) {
      const skippedList = autoAttachReport.skipped
        .slice(0, 8)
        .map(s => `- ${s.relativePath}`)
        .join('\n');
      const more = autoAttachReport.skipped.length > 8
        ? `\n- ...and ${autoAttachReport.skipped.length - 8} more`
        : '';
      this._postMessage({
        type: 'warning',
        text:
          `Auto-attach skipped ${autoAttachReport.skipped.length} file(s) due to the total attachment quota.\n\n` +
          `Skipped:\n${skippedList}${more}\n\n` +
          `Tip: attach fewer files, or use "Attach Editor" with a selection to include only the relevant section.`,
      });
    }

    // Build user message, prepending any attached files that haven't been injected yet
    let userContent = prompt;
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const newFiles = this._sessions.attachedFiles.filter(f => !this._injectedFileUris.has(f.uri));
    /** Chunk IDs delivered in the initial user message — seeded into sentChunkIds below. */
    const initialChunkIds: string[] = [];

    // Context meter: attachment bytes (capped per-file to align with FileTools total cap accounting)
    const attachmentBytes = this._sessions.attachedFiles.reduce(
      (sum, f) => sum + Math.min(f.sizeBytes, FILE_CAP_BYTES),
      0
    );
    const attachmentPct = TOTAL_CAP_BYTES > 0
      ? Math.min(100, Math.round((attachmentBytes / TOTAL_CAP_BYTES) * 100))
      : 0;
    if (newFiles.length > 0) {
      const MAX_INJECTED_CHARS = 18_000;
      const { chunkBlocks, resolvedPaths, skippedDueToInjectionCap, initialChunkIds: ids } =
        await this._chunks.prepareFileChunks(
          newFiles as ChunkAttachedFile[],
          wsRoots,
          prompt,
          autoDetectedThisTurnUris,
          MAX_INJECTED_CHARS,
          this._log
        );
      
      initialChunkIds.push(...ids);

      if (chunkBlocks.length > 0) {
        this._postMessage({ type: 'status', text: `Sending chunks for ${chunkBlocks.length} file(s)…` });
        // Append resolved paths so the model uses exact URIs in search_file / request_chunks
        const pathNote = resolvedPaths.join('\n');
        userContent = `${chunkBlocks.join('\n\n')}\n\n${prompt}` +
          `\n\n<resolved_paths>\n${pathNote}\n</resolved_paths>` +
          (newFiles.length > chunkBlocks.length ? `\n\n<context_note>Attachment context capped to stay within budget.</context_note>` : '');
      }

      // If we skipped some attachments due to injection cap, surface it in-chat.
      if (skippedDueToInjectionCap.length > 0) {
        const shown = skippedDueToInjectionCap.slice(0, 8);
        const list = shown.map(p => `- ${p}`).join('\n');
        const more = skippedDueToInjectionCap.length > 8
          ? `\n- ...and ${skippedDueToInjectionCap.length - 8} more`
          : '';
        this._postMessage({
          type: 'warning',
          text:
            `Attachment context cap reached while preparing the prompt (max ${MAX_INJECTED_CHARS.toLocaleString()} chars). ` +
            `Some attached files were not included in the message sent to the model.\n\n` +
            `Not sent:\n${list}${more}\n\n` +
            `Tip: attach fewer files or attach a smaller selection from the editor.`,
        });
      }
    }

    this._sessions.history.push({ role: 'user', content: userContent, displayContent: prompt });

    // Read AGENTS.md once for this send if the user has opted in
    let agentsMdContent: string | undefined;
    const includeAgentsMd = this._sessions.includeAgentsMd;
    if (includeAgentsMd && wsRoots.length > 0) {
      const agentsMdUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'AGENTS.md');
      try {
        const bytes = await vscode.workspace.fs.readFile(agentsMdUri);
        agentsMdContent = Buffer.from(bytes).toString('utf8');
      } catch {
        // AGENTS.md disappeared between check and send — ignore
      }
    }

    // Determine whether the active provider supports native tool calling
    const activeProviders = this._getProviders();
    const activeIdx = Math.min(this._activeProviderIndex, activeProviders.length - 1);
    const activeProvider = activeProviders[activeIdx];
    const useNativeTools = activeProvider?.toolUse ?? true;

    // Build ToolExecutor for native tool dispatch (used only when useNativeTools=true)
    const toolExecutor = useNativeTools
      ? new ToolExecutor(
          {
            log: this._log,
            postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
            requestApproval: (action, payload, reason) => this._requestApproval(action, payload, reason),
          },
          vscode.workspace.workspaceFolders ?? []
        )
      : null;

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
    let lastFinishReason: string | undefined;

    // Cap native tool rounds to avoid runaway loops
    const MAX_TOOL_ROUNDS = 20;
    let toolRound = 0;
    let toolLimitSummaryRequested = false;
    const MAX_EMPTY_RESPONSE_RETRIES = 1;
    let emptyResponseRetries = 0;
    const MAX_UNRECOGNIZED_JSON_RETRIES = 2;
    let unrecognizedJsonRetries = 0;

    // Set to true if the provider signals it doesn't support native tools;
    // triggers a legacy-prompt re-stream for the current turn.
    let toolsFallbackActive = false;


    const provider = this._getProvider();

    try {
      while (true) {
        let fullResponse = '';
        const pendingToolCalls: ToolCallEvent[] = [];
        const nativeToolMode = useNativeTools && !toolsFallbackActive;
        this._abortController = new AbortController();

        this._log.appendLine(
          `[stream] starting request (chunk round ${chunkRound}, tool round ${toolRound}, nativeToolMode=${nativeToolMode})`
        );
        const messages = this._buildMessages(agentsMdContent, nativeToolMode);
        const contextTokens = await this._tokenCounter.countMessages(messages);
        const exact = this._tokenCounter.isReady;
        this._postMessage({
          type: 'status',
          text:
            `Sending ${exact ? '' : '~'}${contextTokens.toLocaleString()} tokens… ` +
            `(${attachmentPct}% attachment quota)`
        });
        await provider.stream(
          messages,
          this._abortController.signal,
          (event) => {
            if (event.type === 'delta') {
              fullResponse += event.content;
              this._postMessage({ type: 'delta', content: event.content });
            } else if (event.type === 'tool-call') {
              pendingToolCalls.push(event);
            } else if (event.type === 'done') {
              this._log.appendLine(`[stream] done, fullResponse.length=${fullResponse.length}, toolCalls=${pendingToolCalls.length}`);
              lastUsage = event.usage;
              lastFinishReason = event.finishReason;
            } else if (event.type === 'tool-unsupported') {
              this._log.appendLine(`[stream] tool-unsupported: falling back to legacy prompt`);
              toolsFallbackActive = true;
            } else if (event.type === 'error') {
              this._log.appendLine(`[stream] error event: ${event.message}`);
              this._postMessage({ type: 'error', message: event.message });
            }
          },
          {
            tools: nativeToolMode ? buildAgentTools() : undefined,
            extraBody: this._buildExtraBody(activeProvider)
          }
        );
        this._log.appendLine(`[stream] stream() resolved, fullResponse.length=${fullResponse.length}`);
        this._abortController = undefined;

        // If the provider rejected tool calling, switch to legacy mode and re-run the round.
        if (nativeToolMode && toolsFallbackActive && !this._userCancelled) {
          this._postMessage({ type: 'status', text: 'Model does not support tool calling — retrying with legacy format…' });
          continue;
        }

        if (this._userCancelled) {
          break;
        }

        // If the model returned empty with no tool calls after we just fed it tool results,
        // the model can't continue the native tool loop. Fall back to legacy mode.
        if (!fullResponse && pendingToolCalls.length === 0 && toolRound > 0 && nativeToolMode) {
          this._log.appendLine(`[tools] empty response after tool results — falling back to legacy prompt`);
          toolsFallbackActive = true;

          // Prompt the model to summarize findings in plain text while preserving
          // prior tool context in conversation history.
          this._sessions.history.push({
            role: 'user',
            content: 'The search has completed. Based on the information gathered so far, please respond in plain text with your findings and answer the original question directly. Do not output JSON.'
          });

          this._postMessage({ type: 'status', text: 'Model cannot continue tool loop — retrying with legacy format…' });
          continue;
        }


        if (!fullResponse && pendingToolCalls.length === 0) {
          if (!this._userCancelled && emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
            emptyResponseRetries++;
            this._log.appendLine(`[stream] empty response (retry ${emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})`);
            this._sessions.history.push({ role: 'user', content: 'Please continue.' });
            continue;
          }
          if (!this._userCancelled) {
            this._postMessage({
              type: 'warning',
              text: 'Model returned an empty response. Try asking the model to continue or switching providers.'
            });
          }
          break;
        }
        emptyResponseRetries = 0;

        // ── Native tool call loop ────────────────────────────────────────────
        if (nativeToolMode && pendingToolCalls.length > 0 && toolExecutor) {
          toolRound++;
          if (toolRound > MAX_TOOL_ROUNDS) {
            this._log.appendLine(`[tools] tool round limit (${MAX_TOOL_ROUNDS}) reached`);
            if (!toolLimitSummaryRequested) {
              toolLimitSummaryRequested = true;
              toolsFallbackActive = true;
              this._sessions.history.push({
                role: 'user',
                content:
                  'Tool call limit reached. Do not call more tools. Using the gathered tool results already in this conversation, provide the best possible final answer in plain text.',
              });
              this._postMessage({ type: 'status', text: 'Tool call limit reached — generating final answer…' });
              continue;
            }
            this._postMessage({ type: 'status', text: 'Tool call limit reached.' });
            finalResponse = fullResponse;
            break;
          }

          // Record assistant turn with tool calls
          this._sessions.history.push({
            role: 'assistant',
            content: fullResponse,
            tool_calls: pendingToolCalls.map(tc => ({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.args,
            })),
          });

          // Execute each tool call and collect results
          for (const toolCall of pendingToolCalls) {
            this._log.appendLine(`[tools] executing ${toolCall.toolName} (${toolCall.toolCallId})`);
            this._postMessage({ type: 'status', text: `Tool: ${toolCall.toolName}…` });
            const toolResult = await toolExecutor.execute(toolCall);
            const compactResult = this._compactToolResultForHistory(toolCall.toolName, toolResult.result);
            if (compactResult.length !== toolResult.result.length) {
              this._log.appendLine(
                `[tools] compacted ${toolCall.toolName} result for history: ${toolResult.result.length} -> ${compactResult.length} chars`
              );
            }
            // Feed result back as a tool message
            this._sessions.history.push({
              role: 'tool',
              content: compactResult,
              tool_call_id: toolResult.toolCallId,
            });
          }

          continue; // Re-stream with tool results injected
        }

        // ── Tentatively record assistant turn (no tool calls) ────────────────
        this._sessions.history.push({ role: 'assistant', content: fullResponse });

        if (!nativeToolMode) {
          // ── Legacy: JSON/XML data-request loop ──────────────────────────────

          // Check if the model is requesting a file listing
          const fileResult = await this._chunks.processFileRequests(fullResponse, wsRoots, MAX_FILE_ROUNDS, fileRound);
          if (!fileResult.done && fileResult.content) {
            fileRound = fileResult.nextRound;
            this._sessions.history.push({ role: 'user', content: fileResult.content });
            continue;
          }

          // Check if the model is requesting file searches
          const searchResult = await this._chunks.processSearchRequests(
            fullResponse,
            wsRoots,
            MAX_SEARCH_ROUNDS,
            searchRound,
            enforceSearchFirst,
            searchFirstRedirects,
            MAX_SEARCH_FIRST_REDIRECTS
          );

          if (searchResult.redirect) {
            searchFirstRedirects = searchResult.nextRedirects;
            this._log.appendLine(
              `[chunks] redirect ${searchFirstRedirects}/${MAX_SEARCH_FIRST_REDIRECTS}:` +
              ' usage/import query should use search_file before request_chunks'
            );
            this._sessions.history.push({
              role: 'user',
              content:
                '<tool_guidance>For usage/import/reference checks, use local ripgrep via search_file first.' +
                ' Request chunks only after search hits if exact surrounding code is still needed.</tool_guidance>',
            });
            continue;
          }

          if (!searchResult.done && searchResult.content) {
            searchRound = searchResult.nextRound;
            this._sessions.history.push({ role: 'user', content: searchResult.content });
            continue;
          }

          if (searchResult.done && searchRound >= MAX_SEARCH_ROUNDS) {
            this._log.appendLine(`[search] retry limit reached`);
            this._postMessage({ type: 'status', text: 'Search request limit reached.' });
            finalResponse = fullResponse;
            break;
          }

          // Check if the model is requesting more file chunks
          const chunkResult = await this._chunks.processChunkRequests(
            fullResponse,
            wsRoots,
            MAX_CHUNK_ROUNDS,
            chunkRound,
            sentChunkIds,
            MAX_CHUNK_NOOP_ROUNDS,
            chunkNoOpRounds
          );

          if (chunkResult.noOp && chunkResult.content) {
            chunkNoOpRounds = chunkResult.nextNoOpRounds;
            this._sessions.history.push({ role: 'user', content: chunkResult.content });
            continue;
          }

          if (!chunkResult.done && chunkResult.content) {
            chunkRound = chunkResult.nextRound;
            chunkNoOpRounds = chunkResult.nextNoOpRounds;
            this._sessions.history.push({ role: 'user', content: chunkResult.content });
            continue;
          }

          if (chunkResult.done && chunkRound >= MAX_CHUNK_ROUNDS) {
            this._log.appendLine(`[chunks] retry limit reached`);
            this._postMessage({ type: 'status', text: 'Chunk request limit reached. Try attaching more of the file manually.' });
            finalResponse = fullResponse;
            break;
          }

          if (fullResponse.trimStart().startsWith('{')) {
            this._log.appendLine(`[stream] unrecognized JSON response: ${fullResponse.slice(0, 300)}`);
            if (unrecognizedJsonRetries < MAX_UNRECOGNIZED_JSON_RETRIES) {
              unrecognizedJsonRetries++;
              this._sessions.history.push({
                role: 'user',
                content:
                  '<tool_guidance>Return either plain text OR exactly one of these JSON objects: ' +
                  '{"search_file":[{"uri":"path/or/glob","pattern":"...","case_sensitive":false}]}, ' +
                  '{"request_files":[{"glob":"**/*.ts","reason":"..."}]}, ' +
                  '{"request_chunks":[{"uri":"path","preferred":{"near_line":1,"max_chunks":1}}]}. ' +
                  'Do not output other JSON keys.</tool_guidance>',
              });
            }
            // If retry limit exceeded, fall through to break with current response
          }
          else if (fullResponse.trim().length > 0) {
            this._log.appendLine(
              `[stream] legacy non-actionable response (${fullResponse.length} chars): ${this._previewForLog(fullResponse)}`
            );
          }
        }

        finalResponse = fullResponse;
        break;
      }

      // Post 'done' exactly once after all rounds complete
      if (!this._userCancelled) {
        this._postMessage({ type: 'done', usage: lastUsage, finishReason: lastFinishReason });
      }

      // If the model response was truncated, surface an explicit warning.
      if (!this._userCancelled && lastFinishReason === 'length') {
        this._postMessage({
          type: 'warning',
          text:
            'The model stopped because it hit the output token limit (finish_reason="length"). ' +
            'Try asking a narrower question or request "continue".',
        });
      }

      // Process legacy JSON/XML action blocks on:
      // 1) explicit legacy mode, or
      // 2) native mode compatibility path when a tool-capable model emits legacy syntax.
      const shouldProcessLegacyActions =
        !!finalResponse &&
        !this._userCancelled &&
        (
          !useNativeTools ||
          toolsFallbackActive ||
          this._looksLikeLegacyActionOutput(finalResponse)
        );

      if (shouldProcessLegacyActions) {
        if (useNativeTools && !toolsFallbackActive) {
          this._log.appendLine('[stream] compatibility: processing legacy action syntax while native tools are enabled');
        }
        await this._edits.processEdits(finalResponse);
        await this._actions.processAllActions(finalResponse);
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
      this._sessions.saveCurrentSession();
    }
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
        this._sessions.thinkingMode = message.thinkingMode ?? false;
        this._sessions.includeAgentsMd = message.includeAgentsMd ?? false;
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
      case 'saveSettings': {
        this._handleSaveSettings(message.providers).catch((err: unknown) => {
          this._log.appendLine(`[saveSettings] handler error: ${err}`);
        });
        break;
      }
      case 'selectModel': {
        const providers = this._getProviders();
        if (message.providerIndex >= 0 && message.providerIndex < providers.length) {
          this._activeProviderIndex = message.providerIndex;
          this._configManager.setActiveProviderIndex(message.providerIndex);
          const provider = providers[message.providerIndex];
          this._postMessage({ type: 'providerStatus', providerName: provider.name, status: 'checking' });
          this._checkProviderHealth(provider).then(online => {
            this._postMessage({ type: 'providerStatus', providerName: provider.name, status: online ? 'online' : 'offline' });
          });
        }
        break;
      }
      case 'checkboxChange':
        // Update internal state when checkbox is toggled (without sending a message)
        if (message.includeAgentsMd !== undefined) {
          this._sessions.includeAgentsMd = message.includeAgentsMd;
          this._sessions.saveCurrentSession();
        }
        break;
    }
  }

  private async _handleSaveSettings(providers: ProviderConfig[] | undefined): Promise<void> {
    this._log.appendLine(`[_handleSaveSettings] received providers: ${JSON.stringify(providers, null, 2)}`);
    if (!providers || providers.length === 0) {
      this._log.appendLine(`[_handleSaveSettings] no providers to save`);
      return;
    }
    
    const cfg = vscode.workspace.getConfiguration('agent86');
    this._log.appendLine(`[_handleSaveSettings] calling cfg.update with target: Global`);
    
    try {
      const result = await cfg.update('providers', providers, vscode.ConfigurationTarget.Global);
      this._log.appendLine(`[_handleSaveSettings] update completed, result: ${JSON.stringify(result)}`);
      
      // Verify the save by reading back
      const verifyCfg = vscode.workspace.getConfiguration('agent86');
      const verifyInspect = verifyCfg.inspect<ProviderConfig[]>('providers');
      this._log.appendLine(`[_handleSaveSettings] verify - workspaceValue: ${JSON.stringify(verifyInspect?.workspaceValue)}`);
      this._log.appendLine(`[_handleSaveSettings] verify - globalValue: ${JSON.stringify(verifyInspect?.globalValue)}`);
      this._log.appendLine(`[_handleSaveSettings] verify - defaultValue: ${JSON.stringify(verifyInspect?.defaultValue)}`);
    } catch (err) {
      this._log.appendLine(`[_handleSaveSettings] update FAILED`);
      this._log.appendLine(`[_handleSaveSettings] error name: ${err instanceof Error ? err.name : 'unknown'}`);
      this._log.appendLine(`[_handleSaveSettings] error message: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        this._log.appendLine(`[_handleSaveSettings] error stack: ${err.stack}`);
      }
    }
  }

  private async _handleAttachFiles(): Promise<void> {
    await vscode.commands.executeCommand('agentic.attachFiles');
  }

  private async _handleAttachActiveEditor(): Promise<void> {
    const updated = await readActiveEditor(this._sessions.attachedFiles);
    if (updated) {
      this._sessions.attachedFiles = updated;
      this._postMessage({ type: 'attachments', files: updated });
      this._sessions.saveCurrentSession();
    }
  }

  private async _handleSelectSession(): Promise<void> {
    const sessions = this._sessions.loadAllSessions();
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
    this._postMessage({ type: 'checkboxState', thinkingMode: this._sessions.thinkingMode, includeAgentsMd: this._sessions.includeAgentsMd });
    // Send providers so the model dropdown is populated
    this._postMessage({ type: 'providers', providers: this._getProviders(), activeProviderIndex: this._activeProviderIndex });

    if (this._sessions.attachedFiles.length > 0) {
      this._postMessage({ type: 'attachments', files: this._sessions.attachedFiles });
    }
    if (this._sessions.history.length > 0) {
      // Replay the conversation as a series of delta messages followed by done,
      // so the existing output area rendering logic is reused without changes.
      for (const msg of this._sessions.history) {
        if (msg.role === 'user') {
          const display = msg.displayContent ?? msg.content;
          this._postMessage({ type: 'userPrompt', content: display });
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
   * Flush all buffered delta messages to the webview as a single combined message.
   * Called when the webview becomes visible again.
   */
  private _flushDeltaBuffer(): void {
    if (this._deltaBuffer.length === 0) {
      return;
    }

    // Combine all buffered deltas into a single IPC call to avoid thousands of round-trips
    const combined = this._deltaBuffer.join('');
    this._deltaBuffer = [];
    this._view?.webview.postMessage({ type: 'delta', content: combined });
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
