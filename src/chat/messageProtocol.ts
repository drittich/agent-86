import { ProviderConfig } from '../config/ConfigManager';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Messages sent from the extension host to the webview
export type ExtensionToWebview =
  | { type: 'delta'; content: string }
  | { type: 'done'; usage?: TokenUsage; cancelled?: boolean; finishReason?: string }
  | { type: 'warning'; text: string }
  | { type: 'error'; message: string }
  | { type: 'status'; text: string }
  | { type: 'attachments'; files: AttachedFile[] }
  | { type: 'approval/request'; approvalId: string; action: string; payload: unknown; reason: string }
  | { type: 'editorState'; hasActiveEditor: boolean }
  | { type: 'editResult'; uri: string; outcome: 'applied' | 'cancelled' }
  | { type: 'agentsMdAvailable'; available: boolean }
  | { type: 'checkboxState'; thinkingMode: boolean; includeAgentsMd: boolean }
  | { type: 'openSettings'; providers: ProviderConfig[]; activeProviderIndex: number }
  | { type: 'providerStatus'; providerName: string; status: 'online' | 'offline' | 'checking' }
  | { type: 'providers'; providers: ProviderConfig[]; activeProviderIndex: number }
  | { type: 'newSession' };

// Messages sent from the webview to the extension host
export type WebviewToExtension =
  | { type: 'send'; prompt: string; thinkingMode?: boolean; includeAgentsMd?: boolean }
  | { type: 'stop' }
  | { type: 'newSession' }
  | { type: 'attachFiles' }
  | { type: 'attachActiveEditor' }
  | { type: 'selectSession' }
  | { type: 'approval/response'; approvalId: string; approved: boolean }
  | { type: 'checkboxChange'; includeAgentsMd?: boolean }
  | { type: 'saveSettings'; providers?: ProviderConfig[] }
  | { type: 'selectModel'; providerIndex: number };

export interface AttachedFile {
  uri: string;
  relativePath: string;
  languageId: string;
  content: string;
  sizeBytes: number;
}
