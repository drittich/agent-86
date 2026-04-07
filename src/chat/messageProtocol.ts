import { ProviderConfig } from '../config/ConfigManager';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Messages sent from the extension host to the webview
export type ExtensionToWebview =
  | { type: 'delta'; content: string }
  | { type: 'done'; usage?: TokenUsage; cancelled?: boolean; finishReason?: string; contextTokens?: number }
  | { type: 'warning'; text: string }
  | { type: 'error'; message: string }
  | { type: 'status'; text: string }
  | { type: 'attachments'; files: AttachedFile[] }
  | { type: 'approval/request'; approvalId: string; action: string; payload: unknown; reason: string }
  | { type: 'question/request'; questionId: string; question: string }
  | { type: 'pick/request'; pickId: string; prompt: string; options: string[] }
  | { type: 'editorState'; hasActiveEditor: boolean }
  | { type: 'editResult'; uri: string; outcome: 'applied' | 'cancelled' }
  | { type: 'agentsMdAvailable'; available: boolean }
  | { type: 'checkboxState'; thinkingMode: boolean; includeAgentsMd: boolean }
  | { type: 'openSettings'; providers: ProviderConfig[]; activeProviderIndex: number; maxToolRounds: number }
  | { type: 'providerStatus'; providerName: string; status: 'online' | 'offline' | 'checking' }
  | { type: 'providers'; providers: ProviderConfig[]; activeProviderIndex: number }
  | { type: 'tool-activity'; text?: string; label?: string; detail?: string; filePath?: string }
  | { type: 'userPrompt'; content: string }
  | { type: 'newSession' }
  | { type: 'sessions'; sessions: SessionSummary[] };

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  messageCount: number;
}

// Messages sent from the webview to the extension host
export type WebviewToExtension =
  | { type: 'send'; prompt: string; thinkingMode?: boolean; includeAgentsMd?: boolean }
  | { type: 'steer'; prompt: string; thinkingMode?: boolean; includeAgentsMd?: boolean }
  | { type: 'stop' }
  | { type: 'newSession' }
  | { type: 'attachFiles' }
  | { type: 'attachActiveEditor' }
  | { type: 'selectSession' }
  | { type: 'restoreSession'; sessionId: string }
  | { type: 'approval/response'; approvalId: string; approved: boolean }
  | { type: 'approval/alwaysAllow'; action: string }
  | { type: 'question/response'; questionId: string; answer: string }
  | { type: 'pick/response'; pickId: string; indices: number[] }
  | { type: 'checkboxChange'; includeAgentsMd?: boolean }
  | { type: 'saveSettings'; providers?: ProviderConfig[]; maxToolRounds?: number }
  | { type: 'selectModel'; providerIndex: number }
  | { type: 'open-file'; relativePath: string };

export interface AttachedFile {
  uri: string;
  relativePath: string;
  languageId: string;
  content: string;
  sizeBytes: number;
}
