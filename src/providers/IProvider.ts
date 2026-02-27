export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
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

export interface IProvider {
  stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void
  ): Promise<void>;
}
