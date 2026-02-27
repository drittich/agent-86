export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Messages sent from the extension host to the webview
export type ExtensionToWebview =
  | { type: 'delta'; content: string }
  | { type: 'done'; usage?: TokenUsage; cancelled?: boolean }
  | { type: 'error'; message: string }
  | { type: 'status'; text: string }
  | { type: 'attachments'; files: AttachedFile[] }
  | { type: 'approval/request'; approvalId: string; action: string; payload: unknown; reason: string };

// Messages sent from the webview to the extension host
export type WebviewToExtension =
  | { type: 'send'; prompt: string }
  | { type: 'stop' }
  | { type: 'newSession' }
  | { type: 'attachFiles' }
  | { type: 'approval/response'; approvalId: string; approved: boolean };

export interface AttachedFile {
  uri: string;
  relativePath: string;
  languageId: string;
  content: string;
  sizeBytes: number;
}
