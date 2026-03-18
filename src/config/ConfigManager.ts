import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { ChatMessage } from '../providers/IProvider';
import { AttachedFile } from '../chat/messageProtocol';
import { ModelTier } from '../agent/ModelProfile';

// ── Provider schema ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  name: string;        // Display name, e.g., "qwen3-coder:a3b"
  baseUrl: string;     // e.g., "http://localhost:8080/v1"
  model: string;       // e.g., "qwen3-coder:a3b"
  apiKey?: string;     // Optional API key (default: "local")
  toolUse: boolean;    // Whether to enable tool use
  context: number;     // Context window size
}

// ── Session schema ────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  title: string;
  createdAt: number; // Unix ms
  updatedAt?: number; // Unix ms — set on save
  messages: ChatMessage[];
  attachments: AttachedFile[];
  thinkingMode?: boolean;
  includeAgentsMd?: boolean;
  systemPrompt?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(messages: ChatMessage[], createdAt: number): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    const text = (firstUser.displayContent ?? firstUser.content).replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
  }
  return `Session ${new Date(createdAt).toLocaleString()}`;
}

function isValidSession(raw: unknown): raw is Session {
  if (!raw || typeof raw !== 'object') { return false; }
  const c = raw as Partial<Session>;
  return (
    typeof c.sessionId === 'string' &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'number' &&
    Array.isArray(c.messages) &&
    Array.isArray(c.attachments)
  );
}

// ── On-disk file format ───────────────────────────────────────────────────────

interface SessionFile {
  activeSessionId: string | undefined;
  sessions: Session[];
}

// ── ConfigManager ─────────────────────────────────────────────────────────────

export class ConfigManager {
  private _sessions: Session[] = [];
  private _activeSessionId: string | undefined;
  private _workspaceHash!: string;
  private _sessionsDir!: vscode.Uri;
  private _sessionFile!: vscode.Uri;
  private _indexFile!: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ── Public async init ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._workspaceHash = crypto
      .createHash('sha1')
      .update(folderPath ?? '__no-workspace__')
      .digest('hex')
      .slice(0, 8);

    this._sessionsDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'sessions');
    this._sessionFile = vscode.Uri.joinPath(this._sessionsDir, this._workspaceHash + '.json');
    this._indexFile = vscode.Uri.joinPath(this._sessionsDir, 'index.json');

    try {
      await vscode.workspace.fs.createDirectory(this._sessionsDir);
    } catch {
      // already exists or unrecoverable — proceed anyway
    }

    await this._loadFromDisk();
    await this._migrateFromWorkspaceState();
  }

  // ── Public API (reads — synchronous after init) ────────────────────────────

  loadLastSession(): Session | undefined {
    if (this._activeSessionId) {
      return this._sessions.find(s => s.sessionId === this._activeSessionId);
    }
    // Fall back to the most recently created session
    const sorted = [...this._sessions].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0];
  }

  loadAllSessions(): Session[] {
    return this._sessions
      .filter(s => s.messages.some(m => m.role === 'user'))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Public API (writes — async) ────────────────────────────────────────────

  async createSession(): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      sessionId: generateId(),
      title: `Session ${new Date(now).toLocaleString()}`,
      createdAt: now,
      messages: [],
      attachments: [],
    };
    this._sessions.push(session);
    this._activeSessionId = session.sessionId;
    await this._flushToDisk();
    return session;
  }

  async saveSession(session: Session): Promise<void> {
    const updated: Session = {
      ...session,
      title: deriveTitle(session.messages, session.createdAt),
      updatedAt: Date.now(),
    };
    const idx = this._sessions.findIndex(s => s.sessionId === updated.sessionId);
    if (idx >= 0) {
      this._sessions[idx] = updated;
    } else {
      this._sessions.push(updated);
    }
    this._activeSessionId = updated.sessionId;
    await this._flushToDisk();
  }

  async clearLastSession(): Promise<void> {
    this._activeSessionId = undefined;
    await this._flushToDisk();
  }

  // ── Provider / settings (unchanged) ───────────────────────────────────────

  getActiveProviderIndex(): number {
    return this.context.globalState.get<number>('agentic.activeProviderIndex') ?? 0;
  }

  setActiveProviderIndex(index: number): void {
    this.context.globalState.update('agentic.activeProviderIndex', index);
  }

  getModelTier(): ModelTier {
    const tier = vscode.workspace.getConfiguration('agent86').get<string>('modelTier') ?? 'balanced';
    if (tier === 'small' || tier === 'balanced' || tier === 'high') {
      return tier;
    }
    return 'balanced';
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _loadFromDisk(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._sessionFile);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<SessionFile>;
      this._sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      this._activeSessionId = typeof parsed.activeSessionId === 'string'
        ? parsed.activeSessionId
        : undefined;
    } catch {
      this._sessions = [];
      this._activeSessionId = undefined;
    }
  }

  private async _flushToDisk(): Promise<void> {
    try {
      const data: SessionFile = {
        activeSessionId: this._activeSessionId,
        sessions: this._sessions,
      };
      const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      await vscode.workspace.fs.writeFile(this._sessionFile, bytes);
      await this._updateIndex();
    } catch (err) {
      // Non-fatal: in-memory state is authoritative for this session lifetime
    }
  }

  private async _updateIndex(): Promise<void> {
    try {
      let index: Record<string, { path: string; label: string; lastAccessed: string }> = {};
      try {
        const bytes = await vscode.workspace.fs.readFile(this._indexFile);
        index = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        // index doesn't exist yet — start fresh
      }
      const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '__no-workspace__';
      index[this._workspaceHash] = {
        path: folderPath,
        label: folderPath === '__no-workspace__' ? '(no workspace)' : path.basename(folderPath),
        lastAccessed: new Date().toISOString(),
      };
      const bytes = Buffer.from(JSON.stringify(index, null, 2), 'utf8');
      await vscode.workspace.fs.writeFile(this._indexFile, bytes);
    } catch {
      // index update failure is cosmetic
    }
  }

  private async _migrateFromWorkspaceState(): Promise<void> {
    if (this._sessions.length > 0) { return; }

    const sessions: Session[] = [];

    const last = this.context.workspaceState.get<unknown>('agentic.lastSession');
    if (isValidSession(last)) { sessions.push(last); }

    for (const key of this.context.workspaceState.keys()) {
      if (key.startsWith('agentic.session.')) {
        const raw = this.context.workspaceState.get<unknown>(key);
        if (isValidSession(raw) && !sessions.find(s => s.sessionId === raw.sessionId)) {
          sessions.push(raw);
        }
      }
    }

    if (sessions.length === 0) { return; }

    this._sessions = sessions;
    if (isValidSession(last)) {
      this._activeSessionId = last.sessionId;
    }
    await this._flushToDisk();
  }
}
