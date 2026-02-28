import * as vscode from 'vscode';
import { ChatMessage } from '../providers/IProvider';
import { AttachedFile } from '../chat/messageProtocol';

// Session storage key prefix
const SESSION_STORAGE_PREFIX = 'agentic.session.';

// ── Session schema ────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  title: string;
  createdAt: number; // Unix ms
  messages: ChatMessage[];
  attachments: AttachedFile[];
  thinkingMode?: boolean;
  includeAgentsMd?: boolean;
}

// ── Storage keys ─────────────────────────────────────────────────────────────

const LAST_SESSION_KEY = 'agentic.lastSession';

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derive a short title from the first user message in a session,
 * falling back to a timestamp-based label.
 */
function deriveTitle(messages: ChatMessage[], createdAt: number): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    const text = firstUser.content.replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
  }
  return `Session ${new Date(createdAt).toLocaleString()}`;
}

// ── ConfigManager ─────────────────────────────────────────────────────────────

export class ConfigManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Create a new, empty session and persist it as the last session. */
  createSession(): Session {
    const now = Date.now();
    const session: Session = {
      sessionId: generateId(),
      title: `Session ${new Date(now).toLocaleString()}`,
      createdAt: now,
      messages: [],
      attachments: [],
    };
    this._persist(session);
    return session;
  }

  /**
   * Save the current session state.  Automatically updates the title
   * based on the first user message.
   */
  saveSession(session: Session): void {
    const updated: Session = {
      ...session,
      title: deriveTitle(session.messages, session.createdAt),
    };
    this._persist(updated);
  }

  /**
   * Load the most recently persisted session, or `undefined` if none exists.
   */
  loadLastSession(): Session | undefined {
    const raw = this.context.workspaceState.get<unknown>(LAST_SESSION_KEY);
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    // Basic shape validation so stale/corrupt data doesn't crash the extension
    const candidate = raw as Partial<Session>;
    if (
      typeof candidate.sessionId !== 'string' ||
      typeof candidate.title !== 'string' ||
      typeof candidate.createdAt !== 'number' ||
      !Array.isArray(candidate.messages) ||
      !Array.isArray(candidate.attachments)
    ) {
      return undefined;
    }
    return candidate as Session;
  }

  /** Erase the persisted last session (called on explicit "New Session"). */
  clearLastSession(): void {
    this.context.workspaceState.update(LAST_SESSION_KEY, undefined);
  }

  /**
   * Load all stored sessions (last session + any additional ones).
   * Returns sessions sorted by creation date (newest first).
   */
  loadAllSessions(): Session[] {
    const sessions: Session[] = [];
    
    // Load the last session
    const lastSession = this.loadLastSession();
    if (lastSession) {
      sessions.push(lastSession);
    }
    
    // Load additional sessions from workspace state
    const allKeys = this.context.workspaceState.keys();
    for (const key of allKeys) {
      if (key.startsWith(SESSION_STORAGE_PREFIX) && key !== LAST_SESSION_KEY) {
        const raw = this.context.workspaceState.get<unknown>(key);
        if (raw && typeof raw === 'object') {
          const candidate = raw as Partial<Session>;
          if (
            typeof candidate.sessionId === 'string' &&
            typeof candidate.title === 'string' &&
            typeof candidate.createdAt === 'number' &&
            Array.isArray(candidate.messages) &&
            Array.isArray(candidate.attachments)
          ) {
            // Avoid duplicates if lastSession is also stored with a prefix key
            if (!sessions.find(s => s.sessionId === candidate.sessionId)) {
              sessions.push(candidate as Session);
            }
          }
        }
      }
    }
    
    // Sort by creation date, newest first
    return sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  private _persist(session: Session): void {
    this.context.workspaceState.update(LAST_SESSION_KEY, session);
  }
}
