export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  /** Human-readable display text (omits injected file chunks). Used for session restore. */
  displayContent?: string;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ProviderEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; usage?: ProviderUsage }
  | { type: 'error'; message: string };

/** Simple logger interface that matches vscode.OutputChannel */
export interface ILogger {
  appendLine(value: string): void;
}

export interface IProvider {
  stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void
  ): Promise<void>;
}
