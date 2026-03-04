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
  private _currentSession: Session;
  private _history: ChatMessage[] = [];
  private _attachedFiles: AttachedFile[] = [];
  private _thinkingMode = false;
  private _includeAgentsMd = false;

  constructor(private deps: SessionDeps) {
    this._currentSession = deps.configManager.createSession();
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

  /**
   * Load the last session from storage.
   */
  loadLastSession(): Session | null {
    const restored = this.deps.configManager.loadLastSession();
    if (restored) {
      this._currentSession = restored;
      this._history = restored.messages;
      this._attachedFiles = restored.attachments;
      this._thinkingMode = restored.thinkingMode ?? false;
      this._includeAgentsMd = restored.includeAgentsMd ?? false;
    }
    return restored ?? null;
  }

  /**
   * Create a new session, clearing all state.
   */
  newSession(): void {
    this._history = [];
    this._attachedFiles = [];
    this._thinkingMode = false;
    this._includeAgentsMd = false;
    this._currentSession = this.deps.configManager.createSession();
    this.saveCurrentSession();
  }

  /**
   * Restore a session from a given Session object.
   */
  restoreSession(session: Session): void {
    this._history = session.messages;
    this._attachedFiles = session.attachments;
    this._thinkingMode = session.thinkingMode ?? false;
    this._includeAgentsMd = session.includeAgentsMd ?? false;
    this._currentSession = session;
  }

  /**
   * Save the current session to storage.
   */
  saveCurrentSession(): void {
    // Keep persisted history lean: tool outputs (search results, file lists, etc.)
    // can be large and quickly exceed local model/server limits.
    this.compactHistoryInPlace();

    this._currentSession = {
      ...this._currentSession,
      messages: this._history,
      attachments: this._attachedFiles,
      thinkingMode: this._thinkingMode,
      includeAgentsMd: this._includeAgentsMd,
    };
    this.deps.configManager.saveSession(this._currentSession);
  }

  /**
   * Compress large tool blocks in older history so sessions stay small.
   * Keeps head+tail so tags remain visible.
   */
  private summarizeToolHeavyMessage(content: string): string {
    const HEAD = 3000;
    const TAIL = 500;
    if (content.length <= HEAD + TAIL + 200) {
      return content;
    }
    const head = content.slice(0, HEAD);
    const tail = content.slice(-TAIL);
    return `${head}\n\n... [history truncated] ...\n\n${tail}`;
  }

  private looksLikeToolPayload(content: string): boolean {
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
  compactHistoryInPlace(): void {
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
      if (!this.looksLikeToolPayload(m.content)) {
        continue;
      }
      this._history[i] = { ...m, content: this.summarizeToolHeavyMessage(m.content) };
    }
  }

  /**
   * Get all sessions for the session picker.
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