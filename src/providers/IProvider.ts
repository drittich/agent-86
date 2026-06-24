export interface ToolCallRef {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** True when the paired tool result was evicted from history to save context. Read guards must not treat the file as still in context. */
  resultEvicted?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  /** Tool calls made by the assistant in this message (for native tool calling). */
  tool_calls?: ToolCallRef[];
  /** Human-readable display text (omits injected file chunks). Used for session restore. */
  displayContent?: string;
  /** When true, this message was injected by the extension (steering nudge, tool result, etc.) and should not be rendered in the UI. */
  internal?: boolean;
  /**
   * Chain-of-thought captured from this assistant turn. Echoed back on the
   * assistant message in subsequent tool-loop turns for models that require it
   * (DeepSeek V4: `requiresReasoningContentOnAssistantMessages`). Stored once
   * with the turn and never rewritten, preserving the append-only invariant.
   */
  reasoning?: string;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens served from the provider's prompt/KV cache (cache hit), when reported. */
  cachedInputTokens?: number;
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
  | { type: 'done'; usage?: ProviderUsage; finishReason?: string; reasoning?: string }
  | { type: 'error'; message: string }
  | { type: 'tool-unsupported' };

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
  /** Native tool definitions to pass to the model. When provided, uses native tool calling. */
  tools?: import('ai').ToolSet;
  /** Override thinking mode for this request. When false, disables chain-of-thought/thinking (e.g. in answer-only mode). */
  thinkingMode?: boolean;
  /**
   * Echo stored assistant `reasoning` back to the model. Default false: most
   * providers (DeepSeek included) advise against re-sending reasoning, and it
   * changes the cached request prefix, hurting prompt-cache hit rates. Enable
   * only for models that require preserved reasoning (e.g. Kimi-for-Coding).
   */
  preserveReasoning?: boolean;
}
