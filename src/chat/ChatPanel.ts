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
import { classifyTask, TaskClassification } from '../agent/TaskClassifier';
import { getModelProfile, ModelProfile } from '../agent/ModelProfile';

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
  /** Pending question resolvers keyed by questionId. */
  private readonly _questionResolvers = new Map<string, (answer: string) => void>();
  private _questionCounter = 0;
  /** Pending pick resolvers keyed by pickId. */
  private readonly _pickResolvers = new Map<string, (indices: number[]) => void>();
  private _pickCounter = 0;
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
    const maxToolRounds = vscode.workspace.getConfiguration('agent86').get<number>('maxToolRounds') ?? 40;
    this._postMessage({ type: 'openSettings', providers, activeProviderIndex: this._activeProviderIndex, maxToolRounds });
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
    const previousUris = new Set(this._sessions.attachedFiles.map(f => f.uri));
    const added = files.filter(f => !previousUris.has(f.uri));

    this._sessions.attachedFiles = files;
    this._postMessage({ type: 'attachments', files });
    this._sessions.saveCurrentSession();

    for (const f of added) {
      this._postMessage({ type: 'tool-activity', label: 'Attached:', detail: f.relativePath });
    }
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

  private _buildDiscoveryHint(prompt: string): string | undefined {
    const normalized = prompt.toLowerCase();
    const explicitPathPattern = /(^|\s)([\w.-]+\/)+[\w.-]+/;
    if (explicitPathPattern.test(prompt)) {
      return undefined;
    }

    const globs = new Set<string>();

    if (/\bpython\b|\.py\b|pydantic|django|flask|fastapi|pytest|site-packages/.test(normalized)) {
      globs.add('**/*.py');
      globs.add('**/*.pyi');
      globs.add('**/pyproject.toml');
      globs.add('**/requirements*.txt');

      if (/\bstartup\b|\blaunch\b|\bbootstrap\b|\bimport\b|\bmodule\b|\bload\b|\bscan\b|\bcache\b/.test(normalized)) {
        globs.add('web/**/*.py');
        globs.add('web/pgadmin/**/*.py');
        globs.add('web/pgAdmin4.py');
        globs.add('web/setup.py');
        globs.add('web/version.py');
      }
    }
    if (/\btypescript\b|\bjavascript\b|\bnode\b|\breact\b|\bjsx\b|\btsx\b|\bimport\b|\bnpm\b/.test(normalized)) {
      globs.add('src/**/*.ts');
      globs.add('src/**/*.tsx');
      globs.add('**/*.js');
      globs.add('**/*.jsx');
      globs.add('**/package.json');
      globs.add('**/tsconfig.json');
    }
    if (/\bconfig\b|\bstartup\b|\bbuild\b|\blaunch\b|\bbootstrap\b|\bsettings\b/.test(normalized)) {
      globs.add('**/*.json');
      globs.add('**/*.yml');
      globs.add('**/*.yaml');
      globs.add('**/*.toml');
    }
    if (/\bc#\b|\.cs\b|\.sln\b|\.csproj\b/.test(normalized)) {
      globs.add('**/*.cs');
      globs.add('**/*.csproj');
      globs.add('**/*.sln');
    }
    if (/\bc\+\+\b|\bcpp\b|\.cpp\b|\.hpp\b|\.cc\b|\.h\b/.test(normalized)) {
      globs.add('**/*.cpp');
      globs.add('**/*.hpp');
      globs.add('**/*.cc');
      globs.add('**/*.h');
    }

    if (globs.size === 0) {
      return undefined;
    }

    return [
      '<discovery_hint>',
      'If the relevant path is unknown, start with recursive discovery across subdirectories.',
      'Prefer find_files or list_directory with ** globs rather than root-only "*".',
      'Ignored folders and gitignored files are excluded automatically.',
      'For Python application startup analysis, prefer app-owned paths like web/ and web/pgadmin/ before bundled runtime or site-packages code.',
      'Avoid broad workspace-wide content searches such as path="." with generic import patterns when a likely application directory is available.',
      'Likely relevant globs for this request:',
      ...Array.from(globs).map(glob => `- ${glob}`),
      '</discovery_hint>'
    ].join('\n');
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
  private _buildExtraBody(provider: ProviderConfig | undefined, overrideThinking?: boolean): Record<string, unknown> {
    const enableThinking = overrideThinking !== undefined ? overrideThinking : this._sessions.thinkingMode;
    const body: Record<string, unknown> = {
      chat_template_kwargs: { enable_thinking: enableThinking }
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

  /**
   * Detects assistant replies that are still planning or asking to inspect more
   * files instead of answering directly from the gathered evidence.
   */
  private _looksLikeDeferredAnswer(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
      return false;
    }

    const hasStructuredSections =
      /(^|\n)Findings:/i.test(trimmed) &&
      /(^|\n)Recommendation:/i.test(trimmed) &&
      /(^|\n)Where to change:/i.test(trimmed);
    if (hasStructuredSections) {
      return false;
    }

    if (/\b(let me|i(?:'ll| will)|first\s+check|next\s+i(?:'ll| will)|need to check|need to inspect|i should check|i'll create|i will create)\b/i.test(trimmed)) {
      return true;
    }

    if (/(:\s*$|\bcheck the version file\b|\bunderstand the module structure\b)/im.test(trimmed)) {
      return true;
    }

    const nonEmptyLines = trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (nonEmptyLines.length > 0 && nonEmptyLines.every(line => /^[\w./-]+\.[\w]+$/.test(line))) {
      return true;
    }

    return false;
  }

  private _buildFinalAnswerPrompt(options?: {
    noMoreTools?: boolean;
    mentionUncertainty?: boolean;
    strictDirectAnswer?: boolean;
    reason?: string;
    compact?: boolean;
  }): string {
    // Compact mode: short prompt for small models recovering from empty responses.
    if (options?.compact) {
      const evidence = this._summarizeToolEvidence();
      return evidence
        ? `${evidence} Do not call tools. Using only the gathered results, write the final answer now. Be direct and specific.`
        : 'Do not call tools. Using only the gathered results, write the final answer now. Be direct and specific.';
    }

    const noMoreTools = options?.noMoreTools ?? true;
    const mentionUncertainty = options?.mentionUncertainty ?? true;
    const strictDirectAnswer = options?.strictDirectAnswer ?? false;
    const reason = options?.reason ? ` Reason: ${options.reason}.` : '';

    return [
      `Stop exploring.${noMoreTools ? ' Do not call more tools.' : ''}${reason}`,
      'Using only the information already gathered in this conversation, answer the original question directly now.',
      strictDirectAnswer
        ? 'Do not describe more investigation, do not mention checking additional files, and do not propose next steps before answering.'
        : 'Do not output JSON, XML, or tool syntax.',
      'Use this exact structure:',
      'Findings: 2-4 short sentences with concrete observations from the gathered evidence.',
      'Recommendation: 1-2 short sentences describing the most likely implementation approach.',
      'Where to change: a short list of the most relevant file path(s) or function(s) already observed.',
      mentionUncertainty
        ? 'Uncertainty: one short sentence only if the gathered evidence is insufficient; otherwise write "none".'
        : 'Uncertainty: none.'
    ].join(' ');
  }

  private _isDiscoveryToolCall(toolCall: ToolCallEvent): boolean {
    return toolCall.toolName === 'find_files' || toolCall.toolName === 'list_directory';
  }

  private _isSubstantiveToolCall(toolCall: ToolCallEvent): boolean {
    return toolCall.toolName === 'read_file' || toolCall.toolName === 'search_file_contents';
  }

  private _extractToolTarget(toolCall: ToolCallEvent): string {
    if (toolCall.toolName === 'read_file' || toolCall.toolName === 'search_file_contents') {
      return String(toolCall.args['path'] ?? '').replace(/\\/g, '/').toLowerCase();
    }
    if (toolCall.toolName === 'find_files' || toolCall.toolName === 'list_directory') {
      return String(toolCall.args['glob'] ?? '').replace(/\\/g, '/').toLowerCase();
    }
    return '';
  }

  private _isLikelyVendorOrRuntimePath(target: string): boolean {
    if (!target) {
      return false;
    }

    return /(^|\/)(site-packages|node_modules|dist|build|runtime|venv|\.venv|__pycache__)(\/|$)/.test(target) ||
      /^python\/lib\//.test(target) ||
      /^python\/scripts\//.test(target);
  }

  private _normalizeDiscoveryGlob(toolCall: ToolCallEvent): string {
    return String(toolCall.args['glob'] ?? '').trim().toLowerCase();
  }

  private _buildClassifierHint(classification: TaskClassification): string | undefined {
    if (classification.domainHints.length === 0) {
      return undefined;
    }

    const lines = [
      '<task_hint>',
      `Task type: ${classification.taskType.replace(/_/g, ' ')}.`,
    ];

    if (classification.isStartupTask || classification.isModuleLoadTask) {
      lines.push('For startup/module-loading tasks, search for these patterns first:');
      const terms = classification.domainHints.slice(0, 6);
      lines.push(...terms.map(t => `- ${t}`));
      lines.push('Prefer app-owned paths: src/, app/, web/, plugins/, utils/');
      lines.push('Do NOT start with list_directory. Use search_file_contents with these terms first.');
    }

    lines.push('</task_hint>');
    return lines.join('\n');
  }

  private _buildDiscoveryRefocusPrompt(): string {
    return [
      'Broad file discovery is complete. Do not keep expanding generic discovery globs.',
      'Skip vendor, runtime, and package manager directories (node_modules, site-packages, dist, build, .venv, etc.).',
      'Using the directory structure already seen in the discovery results, identify the application-owned source directory.',
      'Choose one of these next actions only:',
      '1. Read the most likely entry-point or initialization file in the application-owned directory (e.g. main.py, app.py, index.ts, __init__.py, or a similarly named top-level file).',
      '2. Run one targeted content search inside the application-owned directory for terms relevant to the task.',
      'Do not use broad recursive patterns again. Do not use execute_bash for file discovery.'
    ].join(' ');
  }

  private _buildConcreteReadRefocusPrompt(): string {
    return [
      'Discovery is complete. You must now call read_file on a specific file — not list_directory or find_files.',
      'Choose the single most relevant file for the task from the directory structure already seen and read it.',
      'Prefer small, focused files (config files, entry scripts, specific modules) over large __init__.py or framework files.',
      'If unsure which file is most relevant, use search_file_contents to find terms related to the task.',
      'Do NOT call list_directory, find_files, or execute_bash.'
    ].join(' ');
  }

  private _buildSearchStallRefocusPrompt(): string {
    return [
      'The search results are in. Continue from the gathered results.',
      'If you need more information, call exactly one tool next — prefer read_file on the most relevant file from the results.',
      'Do not repeat the same search. Do not call find_files or list_directory.',
      'If the results are sufficient, produce your final answer now.'
    ].join(' ');
  }

  /** Summarise tool evidence gathered so far for the final-answer prompt. */
  private _summarizeToolEvidence(): string {
    const reads: string[] = [];
    const searches: string[] = [];
    for (const msg of this._sessions.history) {
      if (msg.role !== 'assistant' || !msg.tool_calls) { continue; }
      for (const tc of msg.tool_calls) {
        const target = String(tc.input?.['path'] ?? '').replace(/\\/g, '/');
        if (tc.toolName === 'read_file' && target) {
          reads.push(target);
        } else if (tc.toolName === 'search_file_contents') {
          const pattern = String(tc.input?.['pattern'] ?? '');
          if (pattern) { searches.push(pattern); }
        }
      }
    }
    const parts: string[] = [];
    if (reads.length > 0) { parts.push(`You have read: ${reads.join(', ')}.`); }
    if (searches.length > 0) { parts.push(`You searched for: ${searches.map(s => `"${s}"`).join(', ')}.`); }
    return parts.join(' ');
  }

  /**
   * Build a compact scratch summary of all tool evidence gathered so far.
   * Used by _collapseToolHistory to replace messy tool transcripts with a
   * clean structured block before requesting the final answer.
   *
   * Format:
   *   Files inspected: <list>
   *   Key findings:
   *   - <file>: <first meaningful non-empty line from tool result>
   *   Search hits: <pattern> → <first match line>
   *   Errors: <any tool errors>
   *   Task: <original prompt>
   */
  private _buildContextScratch(originalPrompt: string): string {
    const lines: string[] = ['[Research summary]'];

    // Collect tool calls with their paired results
    const toolCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const toolResults = new Map<string, string>(); // toolCallId → result

    for (const msg of this._sessions.history) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.push({ toolName: tc.toolName, input: tc.input ?? {} });
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResults.set(msg.tool_call_id, msg.content);
      }
    }

    // Gather reads
    const reads: string[] = [];
    for (const msg of this._sessions.history) {
      if (msg.role !== 'assistant' || !msg.tool_calls) { continue; }
      for (const tc of msg.tool_calls) {
        if (tc.toolName === 'read_file') {
          const p = String(tc.input?.['path'] ?? '').replace(/\\/g, '/');
          if (p && !reads.includes(p)) { reads.push(p); }
        }
      }
    }
    if (reads.length > 0) {
      lines.push(`Files inspected: ${reads.join(', ')}`);
    }

    // Gather key findings: for each file read, pull the first meaningful snippet from result
    const findingLines: string[] = [];
    for (const msg of this._sessions.history) {
      if (msg.role !== 'assistant' || !msg.tool_calls) { continue; }
      for (const tc of msg.tool_calls) {
        if (tc.toolName !== 'read_file') { continue; }
        const filePath = String(tc.input?.['path'] ?? '').replace(/\\/g, '/');
        if (!filePath) { continue; }
        // Find the paired tool result
        const resultMsg = this._sessions.history.find(
          m => m.role === 'tool' && m.tool_call_id === tc.toolCallId
        );
        if (!resultMsg || resultMsg.content.startsWith('Error')) { continue; }
        // Extract first non-trivial line (skip blank lines and file headers)
        const snippet = resultMsg.content
          .split(/\r?\n/)
          .filter(l => l.trim().length > 10)
          .slice(0, 3)
          .join(' | ')
          .slice(0, 200);
        if (snippet) {
          findingLines.push(`- ${filePath}: ${snippet}`);
        }
      }
    }
    if (findingLines.length > 0) {
      lines.push('Key findings:');
      lines.push(...findingLines);
    }

    // Gather search hits
    const searchHits: string[] = [];
    for (const msg of this._sessions.history) {
      if (msg.role !== 'assistant' || !msg.tool_calls) { continue; }
      for (const tc of msg.tool_calls) {
        if (tc.toolName !== 'search_file_contents') { continue; }
        const pattern = String(tc.input?.['pattern'] ?? '');
        if (!pattern) { continue; }
        const resultMsg = this._sessions.history.find(
          m => m.role === 'tool' && m.tool_call_id === tc.toolCallId
        );
        if (!resultMsg) { continue; }
        if (resultMsg.content.startsWith('Error') || resultMsg.content.startsWith('No matches')) {
          searchHits.push(`- "${pattern}": no matches`);
        } else {
          const firstHit = resultMsg.content.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
          searchHits.push(`- "${pattern}": ${firstHit.slice(0, 150)}`);
        }
      }
    }
    if (searchHits.length > 0) {
      lines.push('Search hits:');
      lines.push(...searchHits);
    }

    // Errors
    const errors: string[] = [];
    for (const msg of this._sessions.history) {
      if (msg.role === 'tool' && (msg.content.startsWith('Error') || msg.content.startsWith('No files matched'))) {
        const firstLine = msg.content.split(/\r?\n/)[0].slice(0, 120);
        if (!errors.includes(firstLine)) { errors.push(firstLine); }
      }
    }
    if (errors.length > 0) {
      lines.push(`Errors encountered: ${errors.join('; ')}`);
    }

    lines.push(`Task: ${originalPrompt.slice(0, 300)}`);

    return lines.join('\n');
  }

  /**
   * Collapse the messy tool transcript into a compact scratch summary.
   * Strips all assistant+tool turns from history (keeping only the original
   * user message), then injects the scratch summary as a fresh user message.
   * This dramatically improves context shape before requesting the final answer.
   */
  private _collapseToolHistory(originalPrompt: string): void {
    const scratch = this._buildContextScratch(originalPrompt);

    // Find the first user message (the original task prompt)
    const firstUserIdx = this._sessions.history.findIndex(m => m.role === 'user');
    if (firstUserIdx < 0) { return; }

    const firstUserMsg = this._sessions.history[firstUserIdx];

    // Keep everything before the first user message (should be empty, but safe)
    const before = this._sessions.history.slice(0, firstUserIdx);

    // Replace everything from the first user message onward with:
    //   [original user message] + [scratch summary as new user message]
    this._sessions.history = [
      ...before,
      firstUserMsg,
      { role: 'user', content: scratch },
    ];
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
   *
   * For code files (read_file), uses structural compaction:
   *   - always keeps imports and top-level signatures
   *   - keeps lines matching user prompt tokens + surrounding context
   * For listing/search tools, uses head/tail truncation (content is already line-oriented).
   */
  private _compactToolResultForHistory(toolName: string, result: string, userPrompt = ''): string {
    const strictTools = new Set(['find_files', 'list_directory', 'search_file_contents']);
    const maxChars = strictTools.has(toolName) ? 4000 : 6000;
    if (result.length <= maxChars) {
      return result;
    }

    // Structural compaction for code files
    if (toolName === 'read_file') {
      const structural = this._structuralCompactCode(result, userPrompt, maxChars);
      if (structural.length <= maxChars) {
        return structural;
      }
      // If still too large, fall through to head/tail below
    }

    const lines = result.split(/\r?\n/);
    const headLines = strictTools.has(toolName) ? 80 : 120;
    const tailLines = strictTools.has(toolName) ? 16 : 24;
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

  /**
   * Structural compaction for code file content.
   *
   * Keeps:
   *   1. All import/require/use/include lines (language agnostic)
   *   2. Top-level structural lines: class, function, def, const/let/var exports,
   *      type/interface/enum declarations, method signatures
   *   3. Lines matching user prompt tokens (identifiers > 3 chars) + CONTEXT_LINES around them
   *
   * Omitted spans are replaced with a single `[... N lines omitted ...]` marker.
   */
  private _structuralCompactCode(content: string, userPrompt: string, maxChars: number): string {
    const CONTEXT_LINES = 3;

    const lines = content.split(/\r?\n/);
    const total = lines.length;

    // Regex patterns for "structural" lines worth always keeping
    const IMPORT_RE = /^\s*(import\b|from\s+\S+\s+import|require\s*\(|#include|use\s+\w|using\s+\w)/;
    const SIGNATURE_RE = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|interface\b|type\b|enum\b|const\b|let\b|var\b|def\b|fn\b|pub\s+(fn|struct|enum|trait|impl)\b|struct\b|impl\b|trait\b|abstract\b|override\b|static\b|public\b|private\b|protected\b)[\s<(]/;
    const METHOD_RE = /^\s{2,}(async\s+)?[\w$#][\w$]*\s*[(<]/;
    const DECORATOR_RE = /^\s*@[\w]/;

    // Extract meaningful tokens from the user prompt
    const promptTokens: string[] = [];
    const seen = new Set<string>();
    for (const w of (userPrompt.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      const lw = w.toLowerCase();
      if (lw.length > 3 && !seen.has(lw)) {
        seen.add(lw);
        promptTokens.push(lw);
      }
    }

    const isStructural = (line: string): boolean =>
      IMPORT_RE.test(line) || SIGNATURE_RE.test(line) || METHOD_RE.test(line) || DECORATOR_RE.test(line);

    const matchesPrompt = (line: string): boolean => {
      if (promptTokens.length === 0) { return false; }
      const lower = line.toLowerCase();
      return promptTokens.some(t => lower.includes(t));
    };

    // Build a set of line indices to keep
    const keep = new Set<number>();

    for (let i = 0; i < total; i++) {
      const line = lines[i];
      if (isStructural(line)) {
        keep.add(i);
      } else if (matchesPrompt(line)) {
        // Keep the matching line plus surrounding context
        for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(total - 1, i + CONTEXT_LINES); j++) {
          keep.add(j);
        }
      }
    }

    // Always keep first few lines (file header / shebang / module doc)
    for (let i = 0; i < Math.min(5, total); i++) { keep.add(i); }

    // Reconstruct, collapsing omitted spans into markers
    const output: string[] = [];
    let omitStart = -1;
    let omitCount = 0;

    const flushOmit = () => {
      if (omitCount > 0) {
        output.push(`[... ${omitCount} line(s) omitted ...]`);
        omitCount = 0;
        omitStart = -1;
      }
    };

    for (let i = 0; i < total; i++) {
      if (keep.has(i)) {
        flushOmit();
        output.push(lines[i]);
      } else {
        omitCount++;
        if (omitStart === -1) { omitStart = i; }
      }
    }
    flushOmit();

    return output.join('\n');
  }

  private async _handleSend(prompt: string): Promise<void> {
    if (this._abortController) {
      // Already generating — ignore duplicate sends
      return;
    }
    this._userCancelled = false;

    // Classify task and load model profile for this turn
    const taskClassification = classifyTask(prompt);
    const modelTier = this._configManager.getModelTier();
    const modelProfile = getModelProfile(modelTier);
    this._log.appendLine(
      `[classify] taskType=${taskClassification.taskType}, tier=${modelTier}, ` +
      `domainHints=[${taskClassification.domainHints.join(', ')}], ` +
      `isStartupTask=${taskClassification.isStartupTask}`
    );

    // Auto-detect file references in the prompt and attach them before sending
    const previouslyAttachedUris = new Set(this._sessions.attachedFiles.map(f => f.uri));
    const autoAttachResult = await autoDetectAndAttachFiles(
      prompt,
      this._sessions.attachedFiles,
      (p, opts) => this._requestPick(p, opts)
    );
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

    const discoveryHint = this._buildDiscoveryHint(prompt);
    const classifierHint = this._buildClassifierHint(taskClassification);
    if (discoveryHint) {
      userContent = `${userContent}\n\n${discoveryHint}`;
    }
    if (classifierHint) {
      userContent = `${userContent}\n\n${classifierHint}`;
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
            requestQuestion: (question) => this._requestQuestion(question),
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
    const MAX_TOOL_ROUNDS = vscode.workspace.getConfiguration('agent86').get<number>('maxToolRounds') ?? 40;
    // Profile drives exploration depth — small models get tighter limits
    const MAX_EXPLORATION_TOOL_ROUNDS = modelProfile.maxDiscoveryStepsBeforeRead + modelProfile.maxFileReadsBeforeSummary + 1;
    let toolRound = 0;
    let toolLimitSummaryRequested = false;
    const MAX_EMPTY_RESPONSE_RETRIES = 1;
    let emptyResponseRetries = 0;
const MAX_NATIVE_FINAL_ANSWER_RETRIES = 1;
    let nativeFinalAnswerRetries = 0;
    let forcePlainTextAnswer = false;
    const MAX_UNRECOGNIZED_JSON_RETRIES = 2;
    let unrecognizedJsonRetries = 0;
    let repetitiveDiscoveryRounds = 0;
    const seenDiscoveryGlobs = new Set<string>();
    let substantiveToolRounds = 0;
    const MAX_DISCOVERY_REFOCUS = 1;
    let discoveryRefocuses = 0;
    let concreteReadRefocuses = 0;
    let totalFileReadRounds = 0;
    const MAX_CONCRETE_READ_REFOCUSES = 2;
    let totalConcreteReadRefocuses = 0;
    let lastToolResultWasError = false;
    let lastRoundWasSearchOnly = false;
    // After this many tool rounds, collapse the messy transcript into a compact
    // scratch summary before requesting the final answer. This improves context
    // shape for models that stall on long tool transcripts.
    const SCRATCH_COLLAPSE_THRESHOLD = 4;
    let scratchCollapsed = false;

    // Set to true if the provider signals it doesn't support native tools;
    // triggers a legacy-prompt re-stream for the current turn.
    let toolsFallbackActive = false;

    const providerContextWindow = Math.max(activeProvider?.context ?? 0, 0);
    const finalAnswerContextThreshold = providerContextWindow > 0
      ? Math.floor(providerContextWindow * 0.7)
      : 0;

    const provider = this._getProvider();

    try {
      while (true) {
        let fullResponse = '';
        const pendingToolCalls: ToolCallEvent[] = [];
        const nativeToolMode = useNativeTools && !toolsFallbackActive;
        const bufferPlainTextOnlyResponse = forcePlainTextAnswer;
        this._abortController = new AbortController();

        this._log.appendLine(
          `[stream] starting request (chunk round ${chunkRound}, tool round ${toolRound}, nativeToolMode=${nativeToolMode}, plainTextOnly=${forcePlainTextAnswer})`
        );
        const toolsEnabledThisRound = nativeToolMode && !forcePlainTextAnswer;
        const messages = this._buildMessages(agentsMdContent, toolsEnabledThisRound);
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
              if (!bufferPlainTextOnlyResponse) {
                this._postMessage({ type: 'delta', content: event.content });
              }
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
            tools: toolsEnabledThisRound ? buildAgentTools() : undefined,
            extraBody: this._buildExtraBody(activeProvider, forcePlainTextAnswer ? false : undefined)
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

        // If the model returned empty with no tool calls after tool results, reroute immediately.
        // A silent retry is low-value here: the model has evidence and already decided to produce
        // nothing — re-sending the same context rarely changes the outcome. Instead synthesize a
        // state summary and re-ask in answer-only mode (no tools passed to the provider).
        if (!fullResponse && pendingToolCalls.length === 0 && toolRound > 0 && nativeToolMode) {
          this._log.appendLine(
            `[metrics] stall_event, toolRound=${toolRound}, taskType=${taskClassification.taskType}, tier=${modelTier}`
          );

          // Level 1: Context-aware nudge — one recovery message chosen by state.
          // Record a placeholder assistant turn first to maintain alternation.
          // Fires when:
          //   (a) no file has been read yet (pre-read stall), OR
          //   (b) the last round was search-only and the model returned empty
          //       (broad search → stall pattern — nudge it to read a specific file)
          // Session-wide cap prevents infinite refocus loops.
          const searchStall = lastRoundWasSearchOnly && concreteReadRefocuses < 1;
          if (totalConcreteReadRefocuses < MAX_CONCRETE_READ_REFOCUSES && (totalFileReadRounds === 0 || searchStall)) {
            concreteReadRefocuses++;
            totalConcreteReadRefocuses++;
            this._sessions.history.push({ role: 'assistant', content: '(thinking)' });

            if (lastToolResultWasError) {
              this._log.appendLine('[tools] empty response after failed tool result — prompting model to try a different file');
              this._sessions.history.push({ role: 'user', content: this._buildConcreteReadRefocusPrompt() });
              this._postMessage({ type: 'status', text: 'File not found — trying a different approach…' });
            } else if (searchStall) {
              this._log.appendLine('[tools] empty response after broad search — nudging model to read a specific file');
              this._sessions.history.push({ role: 'user', content: this._buildSearchStallRefocusPrompt() });
              this._postMessage({ type: 'status', text: 'Model paused after search — choosing a concrete file to read…' });
            } else {
              this._log.appendLine('[tools] empty response before any file read — refocusing to a concrete read_file call');
              this._sessions.history.push({ role: 'user', content: this._buildConcreteReadRefocusPrompt() });
              this._postMessage({ type: 'status', text: 'Model paused after discovery — choosing a concrete app file…' });
            }
            continue;
          }

          // Level 2: Final answer mode — collapse transcript + compact prompt, tools disabled.
          if (nativeFinalAnswerRetries < MAX_NATIVE_FINAL_ANSWER_RETRIES) {
            nativeFinalAnswerRetries++;
            forcePlainTextAnswer = true;
            this._log.appendLine(
              `[tools] empty response after tool results — rerouting to answer-only mode (${nativeFinalAnswerRetries}/${MAX_NATIVE_FINAL_ANSWER_RETRIES})`
            );
            // Collapse the messy tool transcript into a clean scratch summary.
            // This fixes the poor context shape that causes models to stall.
            if (!scratchCollapsed && toolRound >= SCRATCH_COLLAPSE_THRESHOLD) {
              scratchCollapsed = true;
              this._log.appendLine(`[tools] collapsing tool history into scratch summary (toolRound=${toolRound})`);
              this._collapseToolHistory(prompt);
              this._postMessage({ type: 'status', text: 'Summarising research…' });
            } else {
              this._sessions.history.push({ role: 'assistant', content: '(thinking)' });
            }
            this._sessions.history.push({
              role: 'user',
              content: this._buildFinalAnswerPrompt({ compact: true })
            });
            this._postMessage({ type: 'status', text: 'Requesting final answer…' });
            continue;
          }

          // All levels exhausted — give up.
          this._log.appendLine(
            `[tools] empty response after tool results — all recovery exhausted`
          );
          const emptyAfterToolsMsg =
            '(Model stopped after tool results without producing a final answer. The gathered tool results remain in the conversation history.)';
          this._postMessage({ type: 'warning', text: 'Model stopped after tool results without producing a final answer.' });
          this._postMessage({ type: 'delta', content: emptyAfterToolsMsg });
          finalResponse = emptyAfterToolsMsg;
          break;
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

        if (bufferPlainTextOnlyResponse && pendingToolCalls.length === 0 && this._looksLikeDeferredAnswer(fullResponse)) {
          this._log.appendLine(
            `[tools] deferred/non-final answer during final-answer mode (${nativeFinalAnswerRetries}/${MAX_NATIVE_FINAL_ANSWER_RETRIES}): ${this._previewForLog(fullResponse)}`
          );

          if (nativeFinalAnswerRetries < MAX_NATIVE_FINAL_ANSWER_RETRIES) {
            nativeFinalAnswerRetries++;
            forcePlainTextAnswer = true;
            this._sessions.history.push({
              role: 'user',
              content: this._buildFinalAnswerPrompt({
                noMoreTools: true,
                mentionUncertainty: true,
                strictDirectAnswer: true,
                reason: 'the previous reply was not a direct final answer'
              })
            });
            this._postMessage({ type: 'status', text: 'Model returned a non-final answer — retrying direct answer…' });
            continue;
          }

          const invalidFinalAnswerMsg =
            '(Model did not provide a direct final answer after tool exploration. The gathered tool results remain in the conversation history.)';
          this._postMessage({ type: 'warning', text: 'Model did not provide a direct final answer.' });
          this._postMessage({ type: 'delta', content: invalidFinalAnswerMsg });
          finalResponse = invalidFinalAnswerMsg;
          break;
        }

        emptyResponseRetries = 0;
        forcePlainTextAnswer = false;
        nativeFinalAnswerRetries = 0;

        if (bufferPlainTextOnlyResponse && fullResponse) {
          this._postMessage({ type: 'delta', content: fullResponse });
        }

        // ── Native tool call loop ────────────────────────────────────────────
        if (nativeToolMode && pendingToolCalls.length > 0 && toolExecutor) {
          const discoveryCalls = pendingToolCalls.filter(tc => this._isDiscoveryToolCall(tc));
          const substantiveCalls = pendingToolCalls.filter(tc => this._isSubstantiveToolCall(tc));
          if (discoveryCalls.length > 0) {
            let repeatedThisRound = false;
            for (const toolCall of discoveryCalls) {
              const normalizedGlob = this._normalizeDiscoveryGlob(toolCall);
              if (!normalizedGlob) {
                continue;
              }
              if (seenDiscoveryGlobs.has(normalizedGlob)) {
                repeatedThisRound = true;
              }
              seenDiscoveryGlobs.add(normalizedGlob);
            }
            repetitiveDiscoveryRounds = repeatedThisRound ? repetitiveDiscoveryRounds + 1 : repetitiveDiscoveryRounds;
          }
          if (substantiveCalls.length > 0) {
            substantiveToolRounds++;
          }

          const upcomingToolRound = toolRound + 1;
          const overToolRoundBudget = upcomingToolRound > MAX_EXPLORATION_TOOL_ROUNDS;
          const overContextBudget = finalAnswerContextThreshold > 0 && contextTokens >= finalAnswerContextThreshold;
          const tooManyDiscoveryGlobs = seenDiscoveryGlobs.size >= 4;
          const excessiveDiscoveryLoop = repetitiveDiscoveryRounds >= 1 && seenDiscoveryGlobs.size >= 3;
          const discoveryLoopWithoutEvidence = substantiveToolRounds === 0 && (tooManyDiscoveryGlobs || excessiveDiscoveryLoop || (upcomingToolRound >= 3 && discoveryCalls.length > 0));
          // Small-model profile: block broad listing as first action regardless of other conditions
          const profileBlocksBroadListing = !modelProfile.allowBroadListingFirst && substantiveToolRounds === 0 && toolRound === 0 && discoveryCalls.length > 0;
          if (!forcePlainTextAnswer && (discoveryLoopWithoutEvidence || profileBlocksBroadListing) && discoveryRefocuses < MAX_DISCOVERY_REFOCUS) {
            discoveryRefocuses++;
            this._log.appendLine(
              `[tools] broad discovery loop detected before substantive evidence — refocusing ` +
              `(nextToolRound=${upcomingToolRound}, seenDiscoveryGlobs=${seenDiscoveryGlobs.size}, repetitiveDiscoveryRounds=${repetitiveDiscoveryRounds})`
            );
            this._sessions.history.push({
              role: 'user',
              content: this._buildDiscoveryRefocusPrompt()
            });
            this._postMessage({ type: 'status', text: 'Broad discovery detected — narrowing to app code…' });
            continue;
          }

          const discoveryLoopAfterEvidence = substantiveToolRounds > 0 && (tooManyDiscoveryGlobs || excessiveDiscoveryLoop);
          const softRoundBudgetExceeded = overToolRoundBudget && (overContextBudget || discoveryLoopAfterEvidence);

          if (!forcePlainTextAnswer && (overContextBudget || softRoundBudgetExceeded || discoveryLoopAfterEvidence)) {
            forcePlainTextAnswer = true;
            this._log.appendLine(
              `[tools] switching to final-answer mode before executing more tools ` +
              `(nextToolRound=${upcomingToolRound}, contextTokens=${contextTokens}, contextThreshold=${finalAnswerContextThreshold || 'n/a'}, ` +
              `seenDiscoveryGlobs=${seenDiscoveryGlobs.size}, repetitiveDiscoveryRounds=${repetitiveDiscoveryRounds}, substantiveToolRounds=${substantiveToolRounds})`
            );
            // After enough tool rounds the history shape degrades badly (many tool blobs,
            // compressed code, errors). Collapse it into a clean scratch summary so the
            // model sees structured findings rather than a messy transcript.
            if (!scratchCollapsed && toolRound >= SCRATCH_COLLAPSE_THRESHOLD) {
              scratchCollapsed = true;
              this._log.appendLine(`[tools] collapsing tool history into scratch summary (toolRound=${toolRound})`);
              this._collapseToolHistory(prompt);
              this._postMessage({ type: 'status', text: 'Summarising research…' });
            }
            this._sessions.history.push({
              role: 'user',
              content: this._buildFinalAnswerPrompt({
                noMoreTools: true,
                mentionUncertainty: true,
                strictDirectAnswer: true,
                reason: discoveryLoopAfterEvidence
                  ? 'the model is repeating broad file discovery instead of synthesizing'
                  : 'the exploration budget is exhausted'
              })
            });
            this._postMessage({ type: 'status', text: 'Context budget reached — generating final answer…' });
            continue;
          }

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
            const limitMsg = '(Tool call limit reached — insufficient context gathered to provide a complete answer.)';
            this._postMessage({ type: 'status', text: 'Tool call limit reached.' });
            if (!fullResponse) {
              this._postMessage({ type: 'delta', content: limitMsg });
              finalResponse = limitMsg;
            } else {
              finalResponse = fullResponse;
            }
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

          // Log first-tool quality for observability
          if (toolRound === 1 && pendingToolCalls.length > 0) {
            const firstTool = pendingToolCalls[0];
            const isTargeted = firstTool.toolName === 'search_file_contents';
            const isBroad = firstTool.toolName === 'find_files' || firstTool.toolName === 'list_directory';
            this._log.appendLine(
              `[metrics] first_tool=${firstTool.toolName}, targeted=${isTargeted}, broad=${isBroad}, ` +
              `taskType=${taskClassification.taskType}, tier=${modelTier}`
            );
          }

          // Execute each tool call and collect results
          const successfulReadTargets = new Set<string>();
          let anySuccessfulSearch = false;
          lastToolResultWasError = false;
          for (const toolCall of pendingToolCalls) {
            this._log.appendLine(`[tools] executing ${toolCall.toolName} (${toolCall.toolCallId})`);
            this._postMessage({ type: 'status', text: `Tool: ${toolCall.toolName}…` });
            const toolResult = await toolExecutor.execute(toolCall);
            if (toolResult.result.startsWith('Error') || toolResult.result.startsWith('No files matched')) {
              lastToolResultWasError = true;
            }
            if (toolCall.toolName === 'read_file' && !toolResult.result.startsWith('Error')) {
              successfulReadTargets.add(this._extractToolTarget(toolCall));
            }
            if (toolCall.toolName === 'search_file_contents' && !toolResult.result.startsWith('Error') && !toolResult.result.startsWith('No matches')) {
              anySuccessfulSearch = true;
            }
            const compactResult = this._compactToolResultForHistory(toolCall.toolName, toolResult.result, prompt);
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

          if (successfulReadTargets.size > 0 || anySuccessfulSearch) {
            totalFileReadRounds++;
          }

          // True when this round was all search/discovery (find_files, list_directory,
          // search_file_contents) with no file reads or writes. Used to detect the
          // "broad search → empty response" stall pattern.
          lastRoundWasSearchOnly = pendingToolCalls.every(tc =>
            tc.toolName === 'find_files' ||
            tc.toolName === 'list_directory' ||
            tc.toolName === 'search_file_contents'
          );

          forcePlainTextAnswer = false;
          nativeFinalAnswerRetries = 0;

          continue; // Re-stream with tool results injected
        }

        // ── Tentatively record assistant turn (no tool calls) ────────────────
        if (fullResponse.trim().length > 0) {
            this._sessions.history.push({ role: 'assistant', content: fullResponse });
        }

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
   * If the action has been persistently allowed for this workspace, returns `true` immediately.
   */
  private _requestApproval(action: string, payload: unknown, reason = ''): Promise<boolean> {
    const alwaysAllowed = this.context.workspaceState.get<string[]>('agentic.alwaysAllowedActions') ?? [];
    if (alwaysAllowed.includes(action)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const approvalId = `approval-${++this._approvalCounter}`;
      this._approvalResolvers.set(approvalId, resolve);
      this._postMessage({ type: 'approval/request', approvalId, action, payload, reason });
    });
  }

  private _persistAlwaysAllow(action: string): void {
    const current = this.context.workspaceState.get<string[]>('agentic.alwaysAllowedActions') ?? [];
    if (!current.includes(action)) {
      this.context.workspaceState.update('agentic.alwaysAllowedActions', [...current, action]);
    }
  }

  private _requestQuestion(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const questionId = `question-${++this._questionCounter}`;
      this._questionResolvers.set(questionId, resolve);
      this._postMessage({ type: 'question/request', questionId, question });
    });
  }

  private _requestPick(prompt: string, options: string[]): Promise<number[]> {
    return new Promise<number[]>((resolve) => {
      const pickId = `pick-${++this._pickCounter}`;
      this._pickResolvers.set(pickId, resolve);
      this._postMessage({ type: 'pick/request', pickId, prompt, options });
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
        // Cancel any pending questions
        for (const [id, resolve] of this._questionResolvers) {
          this._questionResolvers.delete(id);
          resolve('User cancelled.');
        }
        // Cancel any pending picks
        for (const [id, resolve] of this._pickResolvers) {
          this._pickResolvers.delete(id);
          resolve([]);
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
      case 'restoreSession': {
        const all = this._sessions.loadAllSessions();
        const target = all.find(s => s.sessionId === message.sessionId);
        if (target) { this.restoreSession(target); }
        break;
      }
      case 'approval/response': {
        const resolver = this._approvalResolvers.get(message.approvalId);
        if (resolver) {
          this._approvalResolvers.delete(message.approvalId);
          resolver(message.approved);
        }
        break;
      }
      case 'approval/alwaysAllow': {
        this._persistAlwaysAllow(message.action);
        break;
      }
      case 'question/response': {
        const resolver = this._questionResolvers.get(message.questionId);
        if (resolver) {
          this._questionResolvers.delete(message.questionId);
          resolver(message.answer);
        }
        break;
      }
      case 'pick/response': {
        const resolver = this._pickResolvers.get(message.pickId);
        if (resolver) {
          this._pickResolvers.delete(message.pickId);
          resolver(message.indices);
        }
        break;
      }
      case 'saveSettings': {
        this._handleSaveSettings(message.providers, message.maxToolRounds).catch((err: unknown) => {
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

  private async _handleSaveSettings(providers: ProviderConfig[] | undefined, maxToolRounds: number | undefined): Promise<void> {
    this._log.appendLine(`[_handleSaveSettings] received providers: ${JSON.stringify(providers, null, 2)}`);
    const cfg = vscode.workspace.getConfiguration('agent86');

    try {
      if (providers && providers.length > 0) {
        await cfg.update('providers', providers, vscode.ConfigurationTarget.Global);
        this._log.appendLine(`[_handleSaveSettings] providers saved`);
      }
      if (maxToolRounds !== undefined && maxToolRounds >= 1) {
        await cfg.update('maxToolRounds', maxToolRounds, vscode.ConfigurationTarget.Global);
        this._log.appendLine(`[_handleSaveSettings] maxToolRounds saved: ${maxToolRounds}`);
      }
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
    this._postSessionsToWebview();
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
    } else {
      // No conversation yet — show the history panel so the user can pick a session
      this._postSessionsToWebview();
    }
  }

  private _postSessionsToWebview(): void {
    const all = this._sessions.loadAllSessions();
    const summaries = all.map(s => ({
      sessionId: s.sessionId,
      title: s.title,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
    }));
    this._postMessage({ type: 'sessions', sessions: summaries });
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
