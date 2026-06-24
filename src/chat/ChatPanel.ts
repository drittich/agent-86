import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewToExtension, ExtensionToWebview, AttachedFile } from './messageProtocol';
import { AIProvider } from '../providers/AIProvider';
import { probeToolSupport, toolSupportKey } from '../providers/ToolSupportProbe';
import { ChatMessage, ToolCallRef } from '../providers/IProvider';
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
import { getSystemPrompt, getProfilePrompt, getNativeToolsPrompt, getLegacyFormatReference, LEGACY_FORMAT_REFERENCE_MARKER } from '../utils/PromptProcessor';
import { classifyTask, TaskClassification } from '../agent/TaskClassifier';
import { getModelProfile, ModelProfile } from '../agent/ModelProfile';
import { isDeepSeekV4, resolveProfileKey, buildDeepSeekExtraBody, ThinkingLevel } from '../agent/DeepSeekProfile';
import {
  PlanRunState,
  parsePlanItems,
  createPlanRun,
  renderPlanMarkdown,
  buildItemContextMessage,
  buildItemHandoff,
  buildVerifierEvidence,
  buildPlanSummary,
} from '../agent/PlanRunner';
import { initScratchpad, appendScratchpad, readScratchpad } from '../agent/Scratchpad';
import { verifyPlanItem } from '../agent/PlanVerifier';

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
  /** When set, the current generation was interrupted by a steer message. After abort completes, a new send is triggered with this prompt. */
  private _pendingSteer: { prompt: string } | null = null;
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
  private _tokenCounter: TokenCounter | undefined;

  private get tokenCounter(): TokenCounter {
    if (!this._tokenCounter) {
      this._tokenCounter = new TokenCounter();
    }
    return this._tokenCounter;
  }

  // Backpressure handling: buffer deltas when webview is hidden
  private _isViewVisible = true;
  private _deltaBuffer: string[] = [];

  // Track active editor state
  private _hasActiveEditor = false;

  // Whether session has been loaded from storage (deferred to first reveal)
  private _sessionInitialized = false;

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
      getContextWindow: () => this._getActiveProviderConfig()?.context ?? 0,
    });

    this._edits = new ChatPanelEdits({
      log: this._log,
      diffProvider: this._diffProvider,
      postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
      requestApproval: (action, payload, reason) => this._requestApproval(action, payload, reason),
      pushHistory: (msg) => this._sessions.history.push(msg),
      saveSession: () => { this._sessions.saveCurrentSession().catch(e => this._log.appendLine(`[save] ${e}`)); },
    });

    this._actions = new ChatPanelActions({
      log: this._log,
      postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
      requestApproval: (action, payload, reason) => this._requestApproval(action, payload, reason),
      pushHistory: (msg) => this._sessions.history.push(msg),
      saveSession: () => { this._sessions.saveCurrentSession().catch(e => this._log.appendLine(`[save] ${e}`)); },
    });

    // Track active editor state changes
    this._hasActiveEditor = !!vscode.window.activeTextEditor;
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this._hasActiveEditor = !!vscode.window.activeTextEditor;
        this._postMessage({ type: 'editorState', hasActiveEditor: this._hasActiveEditor });
      })
    );
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
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

    // Restore last session on first reveal, or start a fresh one
    if (!this._sessionInitialized) {
      this._sessionInitialized = true;
      await this._sessions.init();
    }

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

  public async newSession(): Promise<void> {
    this._abortController?.abort();
    this._abortController = undefined;
    // Reject any pending approval dialogs so their promises settle cleanly
    for (const [id, resolve] of this._approvalResolvers) {
      this._approvalResolvers.delete(id);
      resolve(false);
    }
    // Settle any pending question/pick resolvers so their promises don't leak
    for (const [id, resolve] of this._questionResolvers) {
      this._questionResolvers.delete(id);
      resolve('');
    }
    for (const [id, resolve] of this._pickResolvers) {
      this._pickResolvers.delete(id);
      resolve([]);
    }
    this._injectedFileUris = new Set();
    this._chunks.chunkMeta = new Map();
    // Discard any buffered deltas — the webview is about to clear its output
    this._deltaBuffer = [];
    await this._sessions.newSession();
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
    this._sessions.saveCurrentSession().catch(e => this._log.appendLine(`[save] ${e}`));

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
   * Show the in-panel session history overlay (called from the toolbar button).
   */
  public showSessionHistory(): void {
    this._postSessionsToWebview();
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
    return [{ name: model, baseUrl, model, apiKey, context: 32768 }];
  }

  private _getProvider(): AIProvider {
    const providerConfig = this._getActiveProviderConfig();
    return new AIProvider(providerConfig!, this._log);
  }

  /** The currently selected provider config, or undefined if none are configured. */
  private _getActiveProviderConfig(): ProviderConfig | undefined {
    const providers = this._getProviders();
    if (providers.length === 0) {
      return undefined;
    }
    const idx = Math.min(this._activeProviderIndex, providers.length - 1);
    return providers[idx];
  }

  /**
   * Resolve whether the active provider supports native tool calling.
   * Uses the cached verdict when available; otherwise runs a one-time probe
   * (a single tiny request with one trivial tool) and caches the result
   * per baseUrl::model.
   */
  private async _resolveToolSupport(provider: ProviderConfig | undefined): Promise<boolean> {
    if (!provider) {
      return true;
    }
    const key = toolSupportKey(provider);
    const cached = this._configManager.getToolSupportVerdict(key);
    if (cached !== undefined) {
      return cached;
    }
    this._postMessage({ type: 'status', text: `Checking tool support for ${provider.name}…` });
    const verdict = await probeToolSupport(provider, this._log);
    if (verdict === 'unknown') {
      // Probe couldn't run (server down, timeout) — use native for this turn
      // without caching so the next message re-probes.
      this._log.appendLine(`[probe] tool support for ${key}: inconclusive — assuming native, will re-probe`);
      return true;
    }
    const supported = verdict === 'native';
    await this._configManager.setToolSupportVerdict(key, supported);
    this._log.appendLine(`[probe] tool support verdict for ${key}: ${verdict}`);
    this._postMessage({
      type: 'status',
      text: supported
        ? 'Native tool calling detected.'
        : 'Model does not produce native tool calls — using legacy format.'
    });
    return supported;
  }

  /**
   * Clear the cached tool-support verdict for the active provider so the next
   * message re-probes (e.g. after a server or chat-template upgrade).
   */
  public async reprobeToolSupport(): Promise<void> {
    const providers = this._getProviders();
    const idx = Math.min(this._activeProviderIndex, providers.length - 1);
    const provider = providers[idx];
    if (!provider) {
      return;
    }
    await this._configManager.clearToolSupportVerdict(toolSupportKey(provider));
    this._log.appendLine(`[probe] cleared tool-support verdict for ${toolSupportKey(provider)}`);
    vscode.window.showInformationMessage(
      `Agent 86: tool support for ${provider.name} will be re-detected on the next message.`
    );
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

    if (/\bc#\b|\bcsharp\b|\.cs\b|\.sln\b|\.csproj\b|\bdotnet\b|\.net\b|\basp\.?net\b|\bef core\b|entity framework|\bcontroller\b|\bbackend\b/.test(normalized)) {
      globs.add('**/*.cs');
      globs.add('**/*.csproj');
      globs.add('**/*.sln');
      globs.add('**/appsettings*.json');
    }
    if (/\btypescript\b|\bjavascript\b|\bnode\b|\breact\b|\bjsx\b|\btsx\b|\bvite\b|\bnpm\b|\bfrontend\b|\bfront-end\b|\bcomponent\b/.test(normalized)) {
      globs.add('src/**/*.ts');
      globs.add('src/**/*.tsx');
      globs.add('**/vite.config.*');
      globs.add('**/package.json');
      globs.add('**/tsconfig.json');
    }
    if (/\bpostgres\b|\bpostgresql\b|\bsql\b|\bdatabase\b|\bmigration\b|\bschema\b|\bnpgsql\b|\bdapper\b/.test(normalized)) {
      globs.add('**/*.sql');
      globs.add('**/Migrations/**/*.cs');
    }
    if (/\bconfig\b|\bstartup\b|\blaunch\b|\bbootstrap\b|\bsettings\b|\benvironment\b/.test(normalized)) {
      globs.add('**/appsettings*.json');
      globs.add('**/*.yml');
      globs.add('**/*.yaml');
    }
    if (/\bpython\b|\.py\b|\bdjango\b|\bflask\b|\bfastapi\b|\bpytest\b/.test(normalized)) {
      globs.add('**/*.py');
      globs.add('**/pyproject.toml');
      globs.add('**/requirements*.txt');
    }

    if (globs.size === 0) {
      return undefined;
    }

    return [
      '<discovery_hint>',
      'Start with search_file_contents using keywords from the task — not with find_files or list_directory.',
      'Only if targeted content searches return zero matches, fall back to find_files with one of these globs:',
      ...Array.from(globs).map(glob => `- ${glob}`),
      'Skip vendor and build-output directories (node_modules, bin, obj, dist, build).',
      'Ignored folders and gitignored files are excluded automatically.',
      '</discovery_hint>'
    ].join('\n');
  }

  private _createSystemPrompt(agentsMdContent?: string): string {
    const thinkingMode = this._sessions.thinkingMode;
    const behaviorInstructions = '## Response style\n\n' + (thinkingMode
      ? `Deliberate before acting. When done, briefly summarize what changed (and why if not obvious).`
      : `Act without preamble — no planning narration, no repetition. If a mid-task update is genuinely needed, one sentence is enough. Afterward: one brief confirmation of what changed, or nothing.`);
    const agentsMdSection = agentsMdContent
      ? `\n\n## AGENTS.md\n${agentsMdContent}`
      : '';

    // Try to load system prompt from prompts/system-prompt.md with dynamic system info injection
    const customSystemPrompt = getSystemPrompt(this.context.extensionUri.fsPath);

    // throw a warning if system prompt not found
    if (!customSystemPrompt) {
      console.warn('** Custom system prompt not found, using fallback prompts.');
    }

    // Model-profile delta: a small per-model fragment (autonomy / planning
    // cadence / tool-call pacing). Stable per session/provider, so it stays
    // inside the cached system prompt and does not perturb the cache prefix.
    const profileSection = this._buildProfileSection();

    // Keep one stable system prompt for the entire turn/session, even if the runtime
    // path falls back from native tool-calling to legacy parsing behavior.
    if (customSystemPrompt) {
      return `${customSystemPrompt.trim()}${agentsMdSection}${profileSection}\n\n${behaviorInstructions}`;
    }

    return getNativeToolsPrompt(agentsMdSection, behaviorInstructions) + profileSection;
  }

  /**
   * Resolve and load the model-profile delta for the active provider's model.
   * Returns an empty string for non-DeepSeek models (no extra prompt weight).
   */
  private _buildProfileSection(): string {
    const provider = this._getActiveProviderConfig();
    const profileKey = resolveProfileKey(provider?.model, this._configManager.getModelTier());
    if (!profileKey) {
      return '';
    }
    const profile = getProfilePrompt(profileKey, this.context.extensionUri.fsPath);
    return profile ? `\n\n${profile}` : '';
  }

  /**
   * Inject the legacy textual-format reference card once per session.
   * The stable system prompt only mentions that fallback formats exist; the
   * exact syntax is delivered here so native-tool models never see it.
   */
  private _ensureLegacyFormatReference(): void {
    const alreadyInjected = this._sessions.history.some(
      m => m.internal && m.content.startsWith(LEGACY_FORMAT_REFERENCE_MARKER)
    );
    if (!alreadyInjected) {
      this._sessions.history.push({
        role: 'user',
        content: getLegacyFormatReference(),
        internal: true,
      });
      this._log.appendLine('[fallback] injected legacy format reference into history');
    }
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
  private _buildExtraBody(
    provider: ProviderConfig | undefined,
    thinkingLevel: ThinkingLevel
  ): Record<string, unknown> {
    const body = this._buildBaseExtraBody(provider, thinkingLevel);

    // Per-model OpenRouter provider pin. Overrides any default routing (including
    // the DeepSeek-V4 default) so the model's author namespace isn't load-balanced
    // to whatever upstream is cheapest. allow_fallbacks: false makes the pin hard.
    const pinned = provider?.openRouterProvider?.trim();
    if (pinned) {
      body.provider = {
        order: [pinned],
        allow_fallbacks: false,
        require_parameters: true,
      };
    }

    return body;
  }

  private _buildBaseExtraBody(
    provider: ProviderConfig | undefined,
    thinkingLevel: ThinkingLevel
  ): Record<string, unknown> {
    // DeepSeek V4 via OpenRouter: thinking is the unified top-level `reasoning`
    // object and routing is pinned to DeepSeek so its on-disk context cache is
    // reachable. This replaces the llama.cpp-style chat_template_kwargs body.
    if (isDeepSeekV4(provider?.model)) {
      return buildDeepSeekExtraBody(thinkingLevel);
    }

    const enableThinking = thinkingLevel !== 'off';
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
  /**
   * Parses textual <tool_call> blocks that some local models (e.g. Qwen) emit
   * instead of using the native tool-calling API.
   *
   * Supported format:
   *   <tool_call>
   *   <function=tool_name>
   *   <parameter=key>value</parameter>
   *   </function>
   *   </tool_call>
   *
   * Also handles compact JSON-in-tool_call:
   *   <tool_call>
   *   {"name": "tool_name", "arguments": {...}}
   *   </tool_call>
   *
   * Returns an array of ToolCallEvent (with synthetic toolCallIds) if any are found,
   * otherwise returns an empty array.
   */
  private _parseTextualToolCalls(content: string): ToolCallEvent[] {
    const results: ToolCallEvent[] = [];
    // Match each <tool_call>...</tool_call> block
    const blockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let blockMatch: RegExpExecArray | null;
    let idCounter = 0;

    while ((blockMatch = blockRe.exec(content)) !== null) {
      const inner = blockMatch[1].trim();

      // Try JSON format first: {"name": "...", "arguments": {...}} or {"function": "...", "parameters": {...}}
      if (inner.startsWith('{')) {
        try {
          const parsed = JSON.parse(inner) as Record<string, unknown>;
          const toolName = String(parsed['name'] ?? parsed['function'] ?? '');
          const args = (parsed['arguments'] ?? parsed['parameters'] ?? {}) as Record<string, unknown>;
          if (toolName) {
            results.push({
              type: 'tool-call',
              toolCallId: `textual-${Date.now()}-${idCounter++}`,
              toolName,
              args,
            });
          }
        } catch {
          // Not valid JSON — ignore this block
        }
        continue;
      }

      // Try XML format: <function=tool_name> ... </function>
      const funcMatch = /^<function=([^\s>]+)>([\s\S]*?)<\/function>$/s.exec(inner);
      if (funcMatch) {
        const toolName = funcMatch[1].trim();
        const paramBlock = funcMatch[2];
        const args: Record<string, unknown> = {};

        const paramRe = /<parameter=([^\s>]+)>([\s\S]*?)<\/parameter>/g;
        let paramMatch: RegExpExecArray | null;
        while ((paramMatch = paramRe.exec(paramBlock)) !== null) {
          const key = paramMatch[1].trim();
          const rawValue = paramMatch[2].trim();
          // Try to parse as JSON (for arrays/objects), fall back to string
          try {
            args[key] = JSON.parse(rawValue);
          } catch {
            args[key] = rawValue;
          }
        }

        if (toolName) {
          results.push({
            type: 'tool-call',
            toolCallId: `textual-${Date.now()}-${idCounter++}`,
            toolName,
            args,
          });
        }
      }
    }

    return results;
  }

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

    if (/\bneed to\b.{0,40}\b(more|additional)\b/i.test(trimmed)) {
      return true;
    }

    if (/\b(please provide|can you share)\b/i.test(trimmed)) {
      return true;
    }

    // A trailing colon on the *last line* strongly suggests the response is a setup for
    // content that was supposed to follow (e.g. "I'll now read the file:"). But many
    // legitimate final answers use colons in headings mid-response — only flag when the
    // very last non-empty line ends with a bare colon and the response is short.
    const nonEmptyLines = trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const lastLine = nonEmptyLines[nonEmptyLines.length - 1] ?? '';
    if (nonEmptyLines.length <= 3 && /:\s*$/.test(lastLine)) {
      return true;
    }

    if (/\b(check the version file|understand the module structure)\b/i.test(trimmed)) {
      return true;
    }

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
    /** True when the task is a comprehension question (no change requested) — answer directly, no change-plan template. */
    explanationTask?: boolean;
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

    const actionTools = new Set(['write_file', 'string_replace', 'copy_file', 'move_file', 'delete_file', 'create_directory', 'execute_bash']);
    const usedActionTool = this._sessions.history.some(
      msg => msg.role === 'assistant' && msg.tool_calls?.some(tc => actionTools.has(tc.toolName))
    );

    const preamble = `Stop.${noMoreTools ? ' Do not call more tools.' : ''}${reason} Summarize what was done in plain text.`;
    const noPropose = strictDirectAnswer
      ? 'Do not describe more investigation, do not mention checking additional files, and do not propose further steps before answering.'
      : 'Do not output JSON, XML, or tool syntax.';

    if (usedActionTool) {
      // Action task: model wrote/edited/ran commands — describe what was done, not where to change.
      return [
        preamble,
        noPropose,
        'Use this exact structure:',
        'Done: 1-3 short sentences stating exactly what was changed or executed.',
        mentionUncertainty
          ? 'Issues: write "none" if everything succeeded, otherwise one short sentence describing any problem or partial failure.'
          : 'If anything failed or only partially succeeded, add one short sentence labelled "Issues:" describing it; otherwise omit it.'
      ].join(' ');
    }

    const uncertaintyLine = mentionUncertainty
      ? 'Uncertainty: write "none" unless evidence is clearly insufficient, in which case write one short sentence explaining what is missing.'
      : 'If evidence is clearly insufficient, add one short sentence labelled "Uncertainty:" explaining what is missing; otherwise omit it.';

    if (options?.explanationTask) {
      // Comprehension question: answer it directly — no change plan, no recommendation slots.
      return [
        `Stop exploring.${noMoreTools ? ' Do not call more tools.' : ''}${reason}`,
        'Using only the information already gathered in this conversation, answer the original question directly now.',
        noPropose,
        'Use this exact structure:',
        'Answer: 2-5 short sentences that directly answer the question, citing concrete evidence (file paths, function names) already observed.',
        'Key locations: a short list of the most relevant file path(s) already observed, if any.',
        uncertaintyLine
      ].join(' ');
    }

    // Change-seeking research task: model only read/searched — describe findings and where to act.
    return [
      `Stop exploring.${noMoreTools ? ' Do not call more tools.' : ''}${reason}`,
      'Using only the information already gathered in this conversation, answer the original question directly now.',
      noPropose,
      'Use this exact structure:',
      'Findings: 2-4 short sentences with concrete observations from the gathered evidence.',
      'Recommendation: 1-2 short sentences describing the most likely implementation approach.',
      'Where to change: a short list of the most relevant file path(s) or function(s) already observed.',
      uncertaintyLine
    ].join(' ');
  }

  private _isDiscoveryToolCall(toolCall: ToolCallEvent): boolean {
    return toolCall.toolName === 'find_files' || toolCall.toolName === 'list_directory';
  }

  private _isSubstantiveToolCall(toolCall: ToolCallEvent): boolean {
    return toolCall.toolName === 'read_file' || toolCall.toolName === 'search_file_contents';
  }

  private _normalizeToolPath(target: string): string {
    return target.replace(/\\/g, '/').replace(/^\.\/?/, '').trim().toLowerCase();
  }

  private _dedupePaths(paths: Iterable<string>): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const rawPath of paths) {
      const normalizedPath = rawPath.replace(/\\/g, '/').replace(/^\.\/?/, '').trim();
      if (!normalizedPath) { continue; }
      const lookup = normalizedPath.toLowerCase();
      if (seen.has(lookup)) { continue; }
      seen.add(lookup);
      deduped.push(normalizedPath);
    }
    return deduped;
  }

  private _extractSearchHitPaths(searchPath: string, result: string): string[] {
    if (result.startsWith('Error') || result.startsWith('No matches')) {
      return [];
    }

    const normalizedSearchPath = searchPath.replace(/\\/g, '/').replace(/^\.\/?/, '').trim();
    const isGlob = /[*?{\[]/.test(searchPath);
    const resultLines = result.split(/\r?\n/).slice(1);
    const hitPaths: string[] = [];

    for (const line of resultLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Note:')) { continue; }
      if (trimmed.startsWith('@') || trimmed.startsWith('>') || /^\d+:/.test(trimmed)) { continue; }
      if (trimmed.includes(': ') || /^Search error:/i.test(trimmed)) { continue; }
      hitPaths.push(trimmed);
    }

    if (hitPaths.length > 0) {
      return this._dedupePaths(hitPaths);
    }

    if (normalizedSearchPath && !isGlob) {
      return [normalizedSearchPath];
    }

    return [];
  }

  private _pathIsWithinSearchScope(searchScope: string, candidatePath: string): boolean {
    const normalizedScope = this._normalizeToolPath(searchScope);
    if (!normalizedScope || /[*?{\[]/.test(searchScope)) {
      return true;
    }

    const normalizedCandidate = this._normalizeToolPath(candidatePath);
    return normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}/`);
  }

  private _formatExactPathList(paths: string[], maxItems = 4): string {
    return this._dedupePaths(paths).slice(0, maxItems).join(', ');
  }

  private _extractToolTarget(toolCall: ToolCallEvent): string {
    if (toolCall.toolName === 'read_file' || toolCall.toolName === 'search_file_contents') {
      return this._normalizeToolPath(String(toolCall.args['path'] ?? ''));
    }
    if (toolCall.toolName === 'find_files' || toolCall.toolName === 'list_directory') {
      return this._normalizeToolPath(String(toolCall.args['glob'] ?? toolCall.args['path'] ?? ''));
    }
    return '';
  }

  /**
   * Builds a map of files already read in this session's history.
   * Key: normalized path. Value: array of covered ranges [{start, end}].
   * A missing start_line/end_line is treated as full-file (0 → Infinity).
   */
  private _buildReadFileCache(fromIndex = 0): Map<string, Array<{ start: number; end: number }>> {
    const cache = new Map<string, Array<{ start: number; end: number }>>();
    for (const msg of this._sessions.history.slice(fromIndex)) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          // Evicted results are no longer in context — the model must be
          // allowed to re-read those files.
          if (tc.toolName === 'read_file' && !tc.resultEvicted) {
            const p = this._normalizeToolPath(String(tc.input['path'] ?? ''));
            if (!p) { continue; }
            const start = typeof tc.input['start_line'] === 'number' ? tc.input['start_line'] : 0;
            const end   = typeof tc.input['end_line']   === 'number' ? tc.input['end_line']   : Infinity;
            if (!cache.has(p)) { cache.set(p, []); }
            cache.get(p)!.push({ start, end });
          }
        }
      }
    }
    return cache;
  }

  /**
   * Returns true if the requested read is fully covered by a prior read in the cache.
   * A full-file read (no range) is only blocked by another full-file read.
   * A ranged read is blocked if a prior read covers its range or is a full-file read.
   */
  private _isDuplicateRead(
    path: string,
    reqStart: number,
    reqEnd: number,
    cache: Map<string, Array<{ start: number; end: number }>>
  ): boolean {
    const normalized = this._normalizeToolPath(path);
    const ranges = cache.get(normalized);
    if (!ranges || ranges.length === 0) { return false; }
    for (const r of ranges) {
      if (r.start <= reqStart && r.end >= reqEnd) {
        return true;
      }
    }
    return false;
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
    return String(toolCall.args['glob'] ?? toolCall.args['path'] ?? '').trim().toLowerCase();
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
      lines.push('Prefer app-owned paths: src/, server/, client/, app/');
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
      '1. Read the most likely entry-point or initialization file in the application-owned directory (e.g. Program.cs, main.tsx, index.ts, main.py, or a similarly named top-level file).',
      '2. Run one targeted content search inside the application-owned directory for terms relevant to the task.',
      'Do not use broad recursive patterns again. Do not use execute_bash for file discovery.'
    ].join(' ');
  }

  private _buildConcreteReadRefocusPrompt(preferredPaths: string[] = []): string {
    const exactPathHint = preferredPaths.length > 0
      ? `Use read_file on one of these exact paths from the search results: ${this._formatExactPathList(preferredPaths)}.`
      : 'Choose the single most relevant file for the task from the directory structure already seen and read it.';

    return [
      'Discovery is complete. You must now call read_file on a specific file — not list_directory or find_files.',
      exactPathHint,
      'Prefer small, focused files (config files, entry scripts, specific modules) over large __init__.py or framework files.',
      'If unsure which file is most relevant, use search_file_contents to find terms related to the task.',
      'Do NOT call list_directory, find_files, or execute_bash.'
    ].join(' ');
  }

  private _buildSearchStallRefocusPrompt(preferredPaths: string[] = []): string {
    const nextStep = preferredPaths.length > 0
      ? `Call exactly one tool next: read_file on one of these exact paths from the last successful search: ${this._formatExactPathList(preferredPaths)}.`
      : 'If you need more information, call exactly one tool next — prefer read_file on the most relevant file from the results.';

    return [
      'The search results are in. Continue from the gathered results.',
      nextStep,
      'Do not repeat the same search. Do not call find_files or list_directory.',
      'If the results are sufficient, produce your final answer now.'
    ].join(' ');
  }

  private _buildSearchRegressionRecoveryPrompt(pattern: string, preferredPaths: string[]): string {
    return [
      `An earlier search for "${pattern}" already found exact matches.`,
      'Do not narrow the search path further or repeat the same search.',
      `Call read_file on one of these exact paths now: ${this._formatExactPathList(preferredPaths)}.`,
      'If the earlier evidence is already sufficient after reading that file, answer directly.'
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

  /**
   * Sliding-window tool-result eviction.
   *
   * When the in-memory history grows past a char threshold, stub every tool
   * result outside the most recent `keepRounds` tool rounds down to a one-line
   * marker. Batched and rare by design: evicting all old results at once drops
   * history well below the threshold, so the prefix KV cache is invalidated
   * once per eviction event rather than every round. Assistant and user turns
   * are never touched.
   */
  private _maybeEvictOldToolResults(): void {
    const cfg = vscode.workspace.getConfiguration('agent86');
    const thresholdChars = cfg.get<number>('toolResultEvictionThresholdChars') ?? 30_000;
    if (thresholdChars <= 0) { return; }
    const keepRounds = Math.max(1, cfg.get<number>('toolResultEvictionKeepRounds') ?? 2);

    const history = this._sessions.history;
    const totalChars = history.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    if (totalChars < thresholdChars) { return; }

    // Tool results at or after this index belong to the most recent
    // `keepRounds` tool rounds and are protected.
    let roundsSeen = 0;
    let protectFrom = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant' && (history[i].tool_calls?.length ?? 0) > 0) {
        roundsSeen++;
        if (roundsSeen >= keepRounds) {
          protectFrom = i;
          break;
        }
      }
    }
    if (protectFrom < 0) { return; }

    const refById = new Map<string, ToolCallRef>();
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) { refById.set(tc.toolCallId, tc); }
      }
    }

    const MIN_EVICT_CHARS = 200;
    let evicted = 0;
    let freedChars = 0;
    for (let i = 0; i < protectFrom; i++) {
      const msg = history[i];
      if (msg.role !== 'tool') { continue; }
      if (msg.content.length <= MIN_EVICT_CHARS) { continue; }
      if (msg.content.startsWith('[elided ')) { continue; }
      const ref = msg.tool_call_id ? refById.get(msg.tool_call_id) : undefined;
      const toolName = ref?.toolName ?? 'tool';
      const target = ref
        ? String(ref.input?.['path'] ?? ref.input?.['glob'] ?? ref.input?.['pattern'] ?? ref.input?.['command'] ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 80)
        : '';
      const originalLength = msg.content.length;
      msg.content =
        `[elided ${toolName}${target ? ` ${target}` : ''} result — ` +
        `${originalLength} chars removed to save context. Call the tool again if you need it.]`;
      if (ref && ref.toolName === 'read_file') {
        ref.resultEvicted = true;
      }
      evicted++;
      freedChars += originalLength - msg.content.length;
    }

    if (evicted > 0) {
      this._log.appendLine(
        `[evict] stubbed ${evicted} old tool result(s), freed ~${freedChars} chars (history was ${totalChars} chars, threshold ${thresholdChars})`
      );
    }
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
    // Anchor for plan mode: per-step context resets are rebuilt around this
    // message (prior history + this task message + step directive).
    const anchorIndex = this._sessions.history.length - 1;

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

    // Determine whether the active provider supports native tool calling.
    // Auto-detected: cached verdict per baseUrl::model, else a one-time probe.
    const activeProviders = this._getProviders();
    const activeIdx = Math.min(this._activeProviderIndex, activeProviders.length - 1);
    const activeProvider = activeProviders[activeIdx];
    // Re-sending reasoning_content is OFF by default — it breaks the cached
    // request prefix and DeepSeek advises against it. Opt-in only (e.g. Kimi).
    const preserveReasoning = vscode.workspace.getConfiguration('agent86').get<boolean>('preserveReasoning') ?? false;
    const useNativeTools = await this._resolveToolSupport(activeProvider);

    // Legacy-verdict models parse textual formats from the stream; give them
    // the exact format reference once per session (the stable system prompt
    // only points at it).
    if (!useNativeTools) {
      this._ensureLegacyFormatReference();
    }

    // Build ToolExecutor for native tool dispatch (used only when useNativeTools=true)
    const toolExecutor = useNativeTools
      ? new ToolExecutor(
          {
            log: this._log,
            postMessage: (msg) => this._postMessage(msg as ExtensionToWebview),
            requestApproval: (action, payload, reason, allowKey) => this._requestApproval(action, payload, reason, allowKey),
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
    let lastContextTokens: number | undefined;

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
    const MAX_TOOL_CONTINUATION_RETRIES = 1;
    let toolContinuationRetries = 0;
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
    let consecutiveEmptyRounds = 0;
    // Backstop demotion: rounds where tools were offered but the model produced
    // neither text nor any (native or salvaged textual) tool call. Repeated
    // failures mark the model as legacy-only for future turns.
    const DEMOTE_AFTER_NO_TOOL_CALL_ROUNDS = 2;
    let consecutiveNoToolCallRounds = 0;
    let toolSupportDemoted = false;
    const MAX_SEARCH_REGRESSION_REFOCUSES = 2;
    let searchRegressionRefocuses = 0;
    let lastSuccessfulSearchPaths: string[] = [];
    const searchNamedReadTargets = new Set<string>();
    const positiveSearchPathsByPattern = new Map<string, string[]>();
    // After this many tool rounds, collapse the messy transcript into a compact
    // scratch summary before requesting the final answer. This improves context
    // shape for models that stall on long tool transcripts.
    const SCRATCH_COLLAPSE_THRESHOLD = 4;
    let scratchCollapsed = false;

    // Snapshot history length at turn start so the duplicate-read guard only
    // considers reads made within this turn, not from prior turns whose tool
    // results may have been compacted out of context. Reset at each plan-step
    // boundary: a fresh step context means previously-read files are gone and
    // may legitimately be re-read.
    let turnHistoryStartIndex = this._sessions.history.length;

    // ── Plan mode ────────────────────────────────────────────────────────────
    // Set when the model calls set_plan. From then on the harness drives:
    // each step runs in a fresh context, the harness detects completion (a
    // non-tool response), verifies it, and advances.
    let planRun: PlanRunState | null = null;
    const wsRoot = wsRoots[0] ?? '';

    // Reset the turn-local exploration/recovery state at a plan-step boundary.
    // A fresh step context gets a fresh budget; without this, stall-recovery
    // caps from earlier steps would bleed into later ones.
    const resetPlanItemCounters = () => {
      turnHistoryStartIndex = this._sessions.history.length;
      emptyResponseRetries = 0;
      toolContinuationRetries = 0;
      nativeFinalAnswerRetries = 0;
      forcePlainTextAnswer = false;
      consecutiveEmptyRounds = 0;
      concreteReadRefocuses = 0;
      totalConcreteReadRefocuses = 0;
      totalFileReadRounds = 0;
      discoveryRefocuses = 0;
      repetitiveDiscoveryRounds = 0;
      seenDiscoveryGlobs.clear();
      substantiveToolRounds = 0;
      lastToolResultWasError = false;
      lastRoundWasSearchOnly = false;
      lastSuccessfulSearchPaths = [];
      searchNamedReadTargets.clear();
      positiveSearchPathsByPattern.clear();
    };

    // Start (or retry) the current plan step: mark it in progress, rebuild
    // history as [prior turns, task message, step directive], reset budgets.
    const startPlanItem = (retryCritique?: string, previousAttemptHandoff?: string) => {
      const pr = planRun!;
      const item = pr.items[pr.currentIndex];
      item.status = 'in_progress';
      pr.itemToolRounds = 0;
      pr.itemBudgetNudged = false;
      const stepContext = buildItemContextMessage(pr, readScratchpad(wsRoot), retryCritique, previousAttemptHandoff);
      this._sessions.history = [
        ...pr.preTurnHistory,
        pr.anchorMessage,
        { role: 'user', content: stepContext, internal: true },
      ];
      pr.itemStartIndex = this._sessions.history.length;
      resetPlanItemCounters();
      const label = `Step ${pr.currentIndex + 1}/${pr.items.length}: ${item.text}`;
      this._log.appendLine(`[plan] starting ${label}${retryCritique ? ' (retry)' : ''}`);
      this._postMessage({ type: 'status', text: label.slice(0, 120) });
      this._postMessage({ type: 'delta', content: `\n\n**${label}**\n\n` });
    };

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
        // If the user cancelled (Stop) or issued a steer before this round begins,
        // avoid starting a new provider stream for the now-stale prompt.
        if (this._userCancelled) {
          break;
        }
        let fullResponse = '';
        // Chain-of-thought from this round's response, stored on the assistant
        // turn so it can be echoed back on later tool-loop turns (DeepSeek V4).
        let capturedReasoning: string | undefined;
        const pendingToolCalls: ToolCallEvent[] = [];
        const nativeToolMode = useNativeTools && !toolsFallbackActive;
        const bufferPlainTextOnlyResponse = forcePlainTextAnswer;
        const toolsEnabledThisRound = nativeToolMode && !forcePlainTextAnswer;
        const thinkingModeThisRound = forcePlainTextAnswer ? false : this._sessions.thinkingMode;
        // Graded thinking by phase: off when thinking is disabled, max during
        // plan-step execution (code-gen / edit / recovery), high otherwise
        // (planning / general). Maps to OpenRouter reasoning effort for DeepSeek.
        const thinkingLevelThisRound: ThinkingLevel =
          !thinkingModeThisRound ? 'off' : (planRun ? 'max' : 'high');
        this._abortController = new AbortController();

        this._log.appendLine(
          `[stream] starting request (chunk round ${chunkRound}, tool round ${toolRound}, nativeToolMode=${nativeToolMode}, plainTextOnly=${forcePlainTextAnswer}, thinkingMode=${thinkingModeThisRound}, thinkingLevel=${thinkingLevelThisRound})`
        );
        const messages = this._buildMessages(agentsMdContent, toolsEnabledThisRound);
        const contextTokens = await this.tokenCounter.countMessages(messages);
        lastContextTokens = contextTokens;
        const exact = this.tokenCounter.isReady;
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
              const cached = event.usage?.cachedInputTokens ?? 0;
              this._log.appendLine(
                `[stream] done, fullResponse.length=${fullResponse.length}, toolCalls=${pendingToolCalls.length}, ` +
                `promptTokens=${event.usage?.promptTokens ?? 0}, cacheHitTokens=${cached}`
              );
              lastUsage = event.usage;
              lastFinishReason = event.finishReason;
              capturedReasoning = event.reasoning;
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
            thinkingMode: thinkingModeThisRound,
            preserveReasoning,
            extraBody: this._buildExtraBody(activeProvider, thinkingLevelThisRound)
          }
        );
        this._log.appendLine(`[stream] stream() resolved, fullResponse.length=${fullResponse.length}`);
        this._abortController = undefined;

        // If the provider rejected tool calling, switch to legacy mode and re-run the round.
        // Persist the verdict so future turns resolve to the legacy format up front.
        if (nativeToolMode && toolsFallbackActive && !this._userCancelled) {
          this._postMessage({ type: 'status', text: 'Model does not support tool calling — retrying with legacy format…' });
          if (activeProvider && !toolSupportDemoted) {
            toolSupportDemoted = true;
            void this._configManager.setToolSupportVerdict(toolSupportKey(activeProvider), false);
            this._log.appendLine(`[probe] recorded legacy verdict for ${toolSupportKey(activeProvider)} (provider rejected tools param)`);
          }
          // The re-streamed round will be parsed as legacy text — make sure the
          // model has the exact textual formats before it responds.
          this._ensureLegacyFormatReference();
          continue;
        }

        if (this._userCancelled) {
          // If interrupted by a steer, flush partial response to history
          if (this._pendingSteer && fullResponse.trim()) {
            this._sessions.history.push({ role: 'assistant', content: fullResponse });
          }
          break;
        }

        // Recovery: some local models (e.g. Qwen) drop to textual <tool_call> syntax instead
        // of using the native API. Parse and salvage those calls before any stall detection.
        if (nativeToolMode && pendingToolCalls.length === 0 && fullResponse) {
          const textualCalls = this._parseTextualToolCalls(fullResponse);
          if (textualCalls.length > 0) {
            this._log.appendLine(
              `[tools] recovered ${textualCalls.length} textual tool call(s) from plain-text response`
            );
            pendingToolCalls.push(...textualCalls);
            // Strip the tool-call blocks from the visible response so the user
            // doesn't see raw XML in the chat output. Keep any surrounding prose.
            const stripped = fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
            if (stripped !== fullResponse) {
              fullResponse = stripped;
            }
          }
        }

        // Track consecutive empty turns so we can distinguish soft stalls (first empty after
        // a search round — model is likely mid-reasoning) from hard stalls (repeated empties,
        // or enough context already gathered).
        if (!fullResponse && pendingToolCalls.length === 0) {
          consecutiveEmptyRounds++;
        } else {
          consecutiveEmptyRounds = 0;
        }

        // Backstop demotion: tools were offered and the model produced nothing
        // at all. Repeated fully-empty rounds mean it can't drive native tools —
        // record a legacy verdict so the next turn skips native mode entirely.
        // (Don't flip modes mid-turn: the legacy prompt and history shape differ.)
        if (toolsEnabledThisRound) {
          if (!fullResponse && pendingToolCalls.length === 0) {
            consecutiveNoToolCallRounds++;
            if (!toolSupportDemoted && consecutiveNoToolCallRounds >= DEMOTE_AFTER_NO_TOOL_CALL_ROUNDS && activeProvider) {
              toolSupportDemoted = true;
              void this._configManager.setToolSupportVerdict(toolSupportKey(activeProvider), false);
              this._log.appendLine(
                `[probe] demoting ${toolSupportKey(activeProvider)} to legacy (${consecutiveNoToolCallRounds} consecutive empty rounds with tools enabled)`
              );
              this._postMessage({
                type: 'warning',
                text: 'Model appears not to support tool calling — switching to the legacy format starting next message.'
              });
            }
          } else {
            consecutiveNoToolCallRounds = 0;
          }
        }

        // If the model returned empty with no tool calls after tool results, reroute immediately.
        // A silent retry is low-value here: the model has evidence and already decided to produce
        // nothing — re-sending the same context rarely changes the outcome. Instead synthesize a
        // state summary and re-ask in answer-only mode (no tools passed to the provider).
        if (!fullResponse && pendingToolCalls.length === 0 && toolRound > 0 && nativeToolMode) {
          // Soft stall: first empty output after a search-only round, early in the loop.
          // The model likely needs to pick a tool but got confused by a large result payload.
          // Inject a lightweight tool-repair nudge (tools still enabled) rather than escalating.
          const isSoftStall =
            consecutiveEmptyRounds === 1 && lastRoundWasSearchOnly && toolRound <= 2;
          if (isSoftStall) {
            this._log.appendLine(
              `[tools] soft stall detected (toolRound=${toolRound}) — injecting tool-repair nudge`
            );
            this._sessions.history.push({
              role: 'user',
              content: this._buildSearchStallRefocusPrompt(lastSuccessfulSearchPaths),
              internal: true,
            });
            this._postMessage({ type: 'status', text: 'Nudging model to select a file…' });
            continue;
          }

          this._log.appendLine(
            `[metrics] stall_event, toolRound=${toolRound}, consecutiveEmpty=${consecutiveEmptyRounds}, taskType=${taskClassification.taskType}, tier=${modelTier}`
          );

          // Level 1: Context-aware nudge — one recovery message chosen by state.
          // Fires when:
          //   (a) no file has been read yet (pre-read stall), OR
          //   (b) the last round was search-only and the model returned empty
          //       (broad search → stall pattern — nudge it to read a specific file)
          // Session-wide cap prevents infinite refocus loops.
          const searchStall = lastRoundWasSearchOnly && concreteReadRefocuses < 1;
          if (totalConcreteReadRefocuses < MAX_CONCRETE_READ_REFOCUSES && (totalFileReadRounds === 0 || searchStall)) {
            concreteReadRefocuses++;
            totalConcreteReadRefocuses++;

            if (lastToolResultWasError) {
              this._log.appendLine('[tools] empty response after failed tool result — prompting model to try a different file');
              this._sessions.history.push({ role: 'user', content: this._buildConcreteReadRefocusPrompt(lastSuccessfulSearchPaths), internal: true });
              this._postMessage({ type: 'status', text: 'File not found — trying a different approach…' });
            } else if (searchStall) {
              this._log.appendLine('[tools] empty response after broad search — nudging model to read a specific file');
              this._sessions.history.push({ role: 'user', content: this._buildSearchStallRefocusPrompt(lastSuccessfulSearchPaths), internal: true });
              this._postMessage({ type: 'status', text: 'Model paused after search — choosing a concrete file to read…' });
            } else {
              this._log.appendLine('[tools] empty response before any file read — refocusing to a concrete read_file call');
              this._sessions.history.push({ role: 'user', content: this._buildConcreteReadRefocusPrompt(lastSuccessfulSearchPaths), internal: true });
              this._postMessage({ type: 'status', text: 'Model paused after discovery — choosing a concrete app file…' });
            }
            continue;
          }

          // Level 2: Tool-continuation mode — retry with tools still enabled + steering prompt.
          // Fires when we're early in the conversation (toolRound < 3) and haven't exhausted
          // the continuation budget. This lets the model call one more tool rather than forcing
          // it to answer with potentially incomplete evidence.
          if (toolContinuationRetries < MAX_TOOL_CONTINUATION_RETRIES && toolRound < 3) {
            toolContinuationRetries++;
            this._log.appendLine(
              `[tools] empty response after tool results — retrying in tool-continuation mode (${toolContinuationRetries}/${MAX_TOOL_CONTINUATION_RETRIES})`
            );
            this._sessions.history.push({
              role: 'user',
              content:
                'You have search results. Continue the investigation. If needed, call one tool to inspect the most relevant file. Do not summarize yet.',
              internal: true,
            });
            this._postMessage({ type: 'status', text: 'Continuing investigation…' });
            continue;
          }

          // Level 3: Final answer mode — collapse transcript + compact prompt, tools disabled.
          // Fires after tool-continuation was tried (or skipped because toolRound >= 3).
          if (nativeFinalAnswerRetries < MAX_NATIVE_FINAL_ANSWER_RETRIES) {
            nativeFinalAnswerRetries++;
            forcePlainTextAnswer = true;
            this._log.appendLine(
              `[tools] empty response after tool results — rerouting to answer-only mode (${nativeFinalAnswerRetries}/${MAX_NATIVE_FINAL_ANSWER_RETRIES})`
            );
            // Collapse the messy tool transcript into a clean scratch summary.
            // This fixes the poor context shape that causes models to stall.
            // Skipped in plan mode: collapsing would strip the step directive;
            // eviction keeps plan-step contexts small instead.
            if (!scratchCollapsed && toolRound >= SCRATCH_COLLAPSE_THRESHOLD && !planRun) {
              scratchCollapsed = true;
              this._log.appendLine(`[tools] collapsing tool history into scratch summary (toolRound=${toolRound})`);
              this._collapseToolHistory(prompt);
              this._postMessage({ type: 'status', text: 'Summarising research…' });
            }
            this._sessions.history.push({
              role: 'user',
              content: this._buildFinalAnswerPrompt({ compact: true }),
              internal: true,
            });
            this._postMessage({ type: 'status', text: 'Requesting final answer…' });
            continue;
          }

          // All levels exhausted (1: context nudge → 2: tool-continuation → 3: answer-only) — give up.
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
            this._sessions.history.push({ role: 'user', content: 'Please continue.', internal: true });
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
                reason: 'the previous reply was not a direct final answer',
                explanationTask: taskClassification.taskType === 'explanation'
              }),
              internal: true,
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
          // ── set_plan interception (harness-driven plan mode) ───────────────
          // Never reaches ToolExecutor: accepting a plan flips the turn into
          // plan mode, where the harness resets context per step.
          const planCall = pendingToolCalls.find(tc => tc.toolName === 'set_plan');
          if (planCall) {
            const planCallRef = {
              toolCallId: planCall.toolCallId,
              toolName: planCall.toolName,
              input: planCall.args,
            };
            if (planRun) {
              this._log.appendLine('[plan] set_plan called while a plan is active — steering back to the current step');
              this._sessions.history.push({ role: 'assistant', content: fullResponse, tool_calls: [planCallRef], reasoning: preserveReasoning ? capturedReasoning : undefined });
              this._sessions.history.push({
                role: 'tool',
                content: 'A plan is already being executed. Continue with the current step only — do not create another plan.',
                tool_call_id: planCall.toolCallId,
              });
              continue;
            }
            const planItems = parsePlanItems(planCall.args);
            if (!planItems) {
              this._sessions.history.push({ role: 'assistant', content: fullResponse, tool_calls: [planCallRef], reasoning: preserveReasoning ? capturedReasoning : undefined });
              this._sessions.history.push({
                role: 'tool',
                content: 'Error: set_plan requires a non-empty "items" array of short step strings. Either call set_plan again with valid items, or proceed without a plan.',
                tool_call_id: planCall.toolCallId,
              });
              continue;
            }
            this._log.appendLine(`[plan] accepted ${planItems.length}-step plan`);
            this._postMessage({ type: 'delta', content: `${renderPlanMarkdown(planItems)}\n` });
            initScratchpad(wsRoot, prompt, planItems);
            planRun = createPlanRun(
              planItems,
              this._sessions.history.slice(0, anchorIndex),
              this._sessions.history[anchorIndex]
            );
            startPlanItem();
            continue;
          }

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
          // In plan mode the per-step budget below governs wrap-up instead of
          // the turn-wide exploration budget.
          const overToolRoundBudget = !planRun && upcomingToolRound > MAX_EXPLORATION_TOOL_ROUNDS;
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
              content: this._buildDiscoveryRefocusPrompt(),
              internal: true,
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
            // Skipped in plan mode (would strip the step directive).
            if (!scratchCollapsed && toolRound >= SCRATCH_COLLAPSE_THRESHOLD && !planRun) {
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
                  : 'the exploration budget is exhausted',
                explanationTask: taskClassification.taskType === 'explanation'
              }),
              internal: true,
            });
            this._postMessage({ type: 'status', text: 'Context budget reached — generating final answer…' });
            continue;
          }

          // ── Per-step tool budget (plan mode) ────────────────────────────────
          // Plan steps are supposed to be narrow; when one exhausts its rounds,
          // ask it to wrap up in answer-only mode instead of letting it flail.
          // The resulting plain-text reply is handled as step completion below.
          if (planRun) {
            const maxItemRounds = vscode.workspace.getConfiguration('agent86').get<number>('maxToolRoundsPerPlanItem') ?? 6;
            if (planRun.itemToolRounds >= maxItemRounds && !planRun.itemBudgetNudged) {
              planRun.itemBudgetNudged = true;
              forcePlainTextAnswer = true;
              this._log.appendLine(
                `[plan] step ${planRun.currentIndex + 1} hit its tool budget (${maxItemRounds} rounds) — requesting wrap-up`
              );
              this._sessions.history.push({
                role: 'user',
                content:
                  'Stop. The tool budget for this plan step is used up. Do not call more tools. ' +
                  'In plain text, state what you completed for this step and what (if anything) is still missing.',
                internal: true,
              });
              this._postMessage({ type: 'status', text: `Step ${planRun.currentIndex + 1} tool budget reached — wrapping up…` });
              continue;
            }
            planRun.itemToolRounds++;
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
                internal: true,
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
            reasoning: preserveReasoning ? capturedReasoning : undefined,
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
          let searchRegressionRecovery:
            | { pattern: string; paths: string[] }
            | undefined;
          // Snapshot of files already read before this round (used for duplicate-read guard)
          const readCache = this._buildReadFileCache(turnHistoryStartIndex);
          for (const toolCall of pendingToolCalls) {
            this._log.appendLine(`[tools] executing ${toolCall.toolName} (${toolCall.toolCallId})`);
            this._postMessage({ type: 'status', text: `Tool: ${toolCall.toolName}…` });

            // Duplicate-read guard: skip re-reading a file that is already fully in history
            // unless the request narrows to a range not previously fetched.
            let compactResult: string;
            if (toolCall.toolName === 'read_file') {
              const reqPath  = String(toolCall.args['path'] ?? '');
              const reqStart = typeof toolCall.args['start_line'] === 'number' ? toolCall.args['start_line'] : 0;
              const reqEnd   = typeof toolCall.args['end_line']   === 'number' ? toolCall.args['end_line']   : Infinity;
              const normalizedReqPath = this._normalizeToolPath(reqPath);
              const isDuplicateRead = this._isDuplicateRead(reqPath, reqStart, reqEnd, readCache);
              const allowSearchNamedReread = isDuplicateRead && searchNamedReadTargets.has(normalizedReqPath);
              if (allowSearchNamedReread) {
                searchNamedReadTargets.delete(normalizedReqPath);
                this._log.appendLine(`[tools] duplicate-read bypassed for search-named file: ${reqPath}`);
              } else if (isDuplicateRead) {
                const rangeNote = reqStart === 0 && reqEnd === Infinity
                  ? 'in full'
                  : `lines ${reqStart}–${reqEnd === Infinity ? 'end' : reqEnd}`;
                const steerMsg = `[guardrail] ${reqPath} was already read ${rangeNote} earlier in this session. ` +
                  `Use the content already in context. If you need a specific line range that hasn't been read, ` +
                  `call read_file with explicit start_line and end_line that do not overlap the prior read.`;
                this._log.appendLine(`[tools] duplicate-read blocked: ${reqPath} (${rangeNote})`);
                compactResult = steerMsg;
                this._sessions.history.push({
                  role: 'tool',
                  content: compactResult,
                  tool_call_id: toolCall.toolCallId,
                });
                continue;
              }
            }

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
            if (toolCall.toolName === 'search_file_contents') {
              const pattern = String(toolCall.args['pattern'] ?? '').trim();
              const patternKey = pattern.toLowerCase();
              const searchPath = String(toolCall.args['path'] ?? '');
              const hitPaths = this._extractSearchHitPaths(searchPath, toolResult.result);

              if (hitPaths.length > 0) {
                const mergedPaths = this._dedupePaths([
                  ...(positiveSearchPathsByPattern.get(patternKey) ?? []),
                  ...hitPaths,
                ]);
                positiveSearchPathsByPattern.set(patternKey, mergedPaths);
                lastSuccessfulSearchPaths = hitPaths;
                for (const hitPath of hitPaths) {
                  searchNamedReadTargets.add(this._normalizeToolPath(hitPath));
                }
              } else if (
                toolResult.result.startsWith('No matches') &&
                patternKey &&
                searchRegressionRefocuses < MAX_SEARCH_REGRESSION_REFOCUSES
              ) {
                const priorHitPaths = positiveSearchPathsByPattern.get(patternKey) ?? [];
                const outOfScopeHits = priorHitPaths.filter(hitPath => !this._pathIsWithinSearchScope(searchPath, hitPath));
                if (outOfScopeHits.length > 0) {
                  searchRegressionRecovery = { pattern, paths: outOfScopeHits };
                  lastSuccessfulSearchPaths = outOfScopeHits;
                  for (const hitPath of outOfScopeHits) {
                    searchNamedReadTargets.add(this._normalizeToolPath(hitPath));
                  }
                }
              }
            }
            compactResult = this._compactToolResultForHistory(toolCall.toolName, toolResult.result, prompt);
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

          if (searchRegressionRecovery) {
            searchRegressionRefocuses++;
            this._log.appendLine(
              `[tools] search narrowed away from earlier hit for "${searchRegressionRecovery.pattern}" — refocusing to exact path(s): ${this._formatExactPathList(searchRegressionRecovery.paths)}`
            );
            this._sessions.history.push({
              role: 'user',
              content: this._buildSearchRegressionRecoveryPrompt(
                searchRegressionRecovery.pattern,
                searchRegressionRecovery.paths
              ),
              internal: true,
            });
          }

          // Sliding-window eviction: once history grows past the threshold,
          // stub tool results older than the most recent rounds. Batched so the
          // prefix KV cache breaks once per eviction event, not every round.
          this._maybeEvictOldToolResults();

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
          consecutiveEmptyRounds = 0;

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
            this._sessions.history.push({ role: 'user', content: fileResult.content, internal: true });
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
              internal: true,
            });
            continue;
          }

          if (!searchResult.done && searchResult.content) {
            searchRound = searchResult.nextRound;
            this._sessions.history.push({ role: 'user', content: searchResult.content, internal: true });
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
            this._sessions.history.push({ role: 'user', content: chunkResult.content, internal: true });
            continue;
          }

          if (!chunkResult.done && chunkResult.content) {
            chunkRound = chunkResult.nextRound;
            chunkNoOpRounds = chunkResult.nextNoOpRounds;
            this._sessions.history.push({ role: 'user', content: chunkResult.content, internal: true });
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
                internal: true,
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

        // ── Plan step completion (harness-decided) ──────────────────────────
        // In plan mode, a non-tool response means the current step claims to be
        // done. Verify it with a one-shot judge call, then retry once or
        // advance. The model never decides transitions — the harness does.
        if (planRun && nativeToolMode && fullResponse.trim().length > 0) {
          const pr = planRun;
          const item = pr.items[pr.currentIndex];
          const stepTranscript = this._sessions.history.slice(pr.itemStartIndex);
          const handoff = buildItemHandoff(item.text, pr.currentIndex, stepTranscript, fullResponse);

          let verdict: { pass: boolean; critique: string } | null = null;
          const verifyEnabled = vscode.workspace.getConfiguration('agent86').get<boolean>('verifyPlanItems') ?? true;
          if (verifyEnabled) {
            this._postMessage({ type: 'status', text: `Verifying step ${pr.currentIndex + 1}/${pr.items.length}…` });
            verdict = await verifyPlanItem(
              this._getProvider(),
              {
                itemText: item.text,
                evidence: buildVerifierEvidence(stepTranscript, fullResponse),
                // Thinking off; no id_slot so the judge call doesn't thrash the
                // session's llama.cpp cache slot.
                extraBody: { chat_template_kwargs: { enable_thinking: false } },
              },
              this._log
            );
          }

          if (verdict && !verdict.pass && !pr.itemRetried) {
            pr.itemRetried = true;
            this._postMessage({
              type: 'delta',
              content: `\n_Step ${pr.currentIndex + 1} verification failed: ${verdict.critique || 'incomplete'} — retrying._\n`,
            });
            startPlanItem(verdict.critique || 'the step was judged incomplete', handoff);
            continue;
          }

          // Finalize the step (a null verdict — verifier unavailable — accepts).
          const failed = !!verdict && !verdict.pass;
          item.status = failed ? 'failed' : 'done';
          const responseFirstLine = fullResponse.split(/\r?\n/).find(l => l.trim().length > 0)?.trim().slice(0, 140) ?? '';
          item.outcome = failed ? `incomplete: ${verdict!.critique || 'failed verification twice'}` : responseFirstLine;
          pr.handoffNotes.push(handoff);
          appendScratchpad(wsRoot, handoff);
          pr.itemRetried = false;
          this._log.appendLine(`[plan] step ${pr.currentIndex + 1}/${pr.items.length} ${item.status}`);

          pr.currentIndex++;
          if (pr.currentIndex < pr.items.length) {
            startPlanItem();
            continue;
          }

          // All steps finished: replace the plan transcript with a clean
          // [task, summary] pair so the next user turn starts from a small,
          // well-shaped history.
          const summary = buildPlanSummary(pr);
          this._postMessage({ type: 'delta', content: `\n\n${summary}` });
          this._sessions.history = [
            ...pr.preTurnHistory,
            pr.anchorMessage,
            { role: 'assistant', content: summary },
          ];
          finalResponse = summary;
          planRun = null;
          break;
        }

        finalResponse = fullResponse;
        break;
      }

      // Post 'done' exactly once after all rounds complete
      if (!this._userCancelled) {
        this._postMessage({ type: 'done', usage: lastUsage, finishReason: lastFinishReason, contextTokens: lastContextTokens });
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
    if (finalResponse || !this._userCancelled || this._pendingSteer) {
      await this._sessions.saveCurrentSession();
    }

    // If interrupted by a steer, chain into a new send with the steer prompt
    const steer = this._pendingSteer;
    if (steer) {
      this._pendingSteer = null;
      this._userCancelled = false;
      this._abortController = undefined;
      this._log.appendLine(`[steer] chaining into new send: ${steer.prompt.slice(0, 80)}`);
      await this._handleSend(steer.prompt);
    }
  }

  /**
   * Send an `approval/request` to the webview and wait for the user's
   * `approval/response`. Returns `true` if approved, `false` if cancelled.
   * If the action has been persistently allowed for this workspace, returns `true` immediately.
   */
  private _requestApproval(action: string, payload: unknown, reason = '', allowKey?: string): Promise<boolean> {
    // `allowKey` lets callers scope "always allow" more narrowly than the action
    // (e.g. a specific command family) while keeping `action` for display/risk.
    const key = allowKey ?? action;
    const alwaysAllowed = this.context.workspaceState.get<string[]>('agentic.alwaysAllowedActions') ?? [];
    if (alwaysAllowed.includes(key)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const approvalId = `approval-${++this._approvalCounter}`;
      this._approvalResolvers.set(approvalId, resolve);
      this._postMessage({ type: 'approval/request', approvalId, action, payload, reason, allowKey });
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
      case 'steer':
        this._sessions.thinkingMode = message.thinkingMode ?? false;
        this._sessions.includeAgentsMd = message.includeAgentsMd ?? false;
        this._pendingSteer = { prompt: message.prompt };
        this._userCancelled = true;
        this._abortController?.abort();
        this._abortController = undefined;
        // Reject any approval cards that are still pending
        for (const [id, resolve] of this._approvalResolvers) {
          this._approvalResolvers.delete(id);
          resolve(false);
        }
        for (const [id, resolve] of this._questionResolvers) {
          this._questionResolvers.delete(id);
          resolve('User cancelled.');
        }
        for (const [id, resolve] of this._pickResolvers) {
          this._pickResolvers.delete(id);
          resolve([]);
        }
        // No 'done' message — the pending steer will trigger a new generation
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
          this._sessions.saveCurrentSession().catch(e => this._log.appendLine(`[save] ${e}`));
        }
        break;
      case 'open-file': {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (wsFolder) {
          const uri = vscode.Uri.joinPath(wsFolder.uri, message.relativePath);
          vscode.window.showTextDocument(uri, { preview: false }).then(undefined, (err: unknown) => {
            this._log.appendLine(`[open-file] failed to open ${message.relativePath}: ${err}`);
          });
        }
        break;
      }
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
      await this._sessions.saveCurrentSession();
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
    // Clear the existing chat output before replaying the restored session
    this._postMessage({ type: 'newSession' });
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
        if (msg.internal) { continue; }
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
    const all = this._sessions.loadAllSessions().slice(0, 10);
    const summaries = all.map(s => ({
      sessionId: s.sessionId,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
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
