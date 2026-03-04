export interface ToolCallRef {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  /** Tool calls made by the assistant in this message (for native tool calling). */
  tool_calls?: ToolCallRef[];
  /** Human-readable display text (omits injected file chunks). Used for session restore. */
  displayContent?: string;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCallEvent {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type ProviderEvent =
  | { type: 'delta'; content: string }
  | ToolCallEvent
  | { type: 'done'; usage?: ProviderUsage; finishReason?: string }
  | { type: 'error'; message: string };

/** Simple logger interface that matches vscode.OutputChannel */
export interface ILogger {
  appendLine(value: string): void;
}

export interface IProvider {
  stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void,
    options?: StreamOptions
  ): Promise<void>;
}

export interface StreamOptions {
  extraBody?: Record<string, unknown>;
  /** Native tool definitions to pass to the model. When provided and toolUse is enabled, uses native tool calling. */
  tools?: import('ai').ToolSet;
}
