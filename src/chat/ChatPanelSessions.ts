import * as vscode from 'vscode';
import { ConfigManager, Session } from '../config/ConfigManager';
import { ChatMessage } from '../providers/IProvider';
import { AttachedFile } from './messageProtocol';

export interface SessionDeps {
  configManager: ConfigManager;
  log: vscode.OutputChannel;
  postMessage: (message: unknown) => void;
}

export class ChatPanelSessions {
  private _currentSession!: Session;
  private _history: ChatMessage[] = [];
  private _attachedFiles: AttachedFile[] = [];
  private _thinkingMode = true;
  private _includeAgentsMd = false;
  private _systemPrompt?: string;

  constructor(private deps: SessionDeps) {}

  /**
   * Initialize storage and load or create the active session.
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    await this.deps.configManager.init();
    const restored = this.loadLastSession();
    if (!restored) {
      await this.newSession();
    }
  }

  public get currentSession(): Session {
    return this._currentSession;
  }

  public get history(): ChatMessage[] {
    return this._history;
  }

  public set history(value: ChatMessage[]) {
    this._history = value;
  }

  public get attachedFiles(): AttachedFile[] {
    return this._attachedFiles;
  }

  public set attachedFiles(value: AttachedFile[]) {
    this._attachedFiles = value;
  }

  public get thinkingMode(): boolean {
    return this._thinkingMode;
  }

  public set thinkingMode(value: boolean) {
    this._thinkingMode = value;
  }

  public get includeAgentsMd(): boolean {
    return this._includeAgentsMd;
  }

  public set includeAgentsMd(value: boolean) {
    this._includeAgentsMd = value;
  }

  public get systemPrompt(): string | undefined {
    return this._systemPrompt;
  }

  public getOrCreateSystemPrompt(factory: () => string): string {
    if (!this._systemPrompt) {
      this._systemPrompt = factory();
    }
    return this._systemPrompt;
  }

  /**
   * Load the last session from the in-memory cache (sync after init).
   */
  loadLastSession(): Session | null {
    const restored = this.deps.configManager.loadLastSession();
    if (restored) {
      this._currentSession = restored;
      this._history = restored.messages;
      this._attachedFiles = restored.attachments;
      this._thinkingMode = restored.thinkingMode ?? true;
      this._includeAgentsMd = restored.includeAgentsMd ?? false;
      this._systemPrompt = restored.systemPrompt;
    }
    return restored ?? null;
  }

  /**
   * Create a new session, clearing all state.
   */
  async newSession(): Promise<void> {
    this._history = [];
    this._attachedFiles = [];
    this._thinkingMode = true;
    this._includeAgentsMd = false;
    this._systemPrompt = undefined;
    this._currentSession = await this.deps.configManager.createSession();
  }

  /**
   * Restore a session from a given Session object.
   */
  restoreSession(session: Session): void {
    this._history = session.messages;
    this._attachedFiles = session.attachments;
    this._thinkingMode = session.thinkingMode ?? true;
    this._includeAgentsMd = session.includeAgentsMd ?? false;
    this._systemPrompt = session.systemPrompt;
    this._currentSession = session;
  }

  /**
   * Save the current session to storage.
   */
  async saveCurrentSession(): Promise<void> {
    this._currentSession = {
      ...this._currentSession,
      messages: this._history,
      attachments: this._attachedFiles,
      thinkingMode: this._thinkingMode,
      includeAgentsMd: this._includeAgentsMd,
      systemPrompt: this._systemPrompt,
    };
    await this.deps.configManager.saveSession(this._currentSession);
  }

  /**
   * Get all sessions for the session picker (sync — reads from cache).
   */
  loadAllSessions(): Session[] {
    return this.deps.configManager.loadAllSessions();
  }

  /**
   * Get the ConfigManager instance.
   */
  getConfigManager(): ConfigManager {
    return this.deps.configManager;
  }
}
