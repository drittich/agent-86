import { streamText } from 'ai';
import { IProvider, ChatMessage, ProviderEvent, ILogger } from './IProvider';
import { ProviderConfig } from '../config/ConfigManager';
import { createProvider, AIProviderInstance } from './ProviderFactory';

/**
 * AIProvider wraps the Vercel AI SDK to provide streaming chat completions.
 * Supports multiple providers (OpenAI, Anthropic, OpenRouter, OpenAI-compatible)
 * via auto-detection from the base URL.
 */
export class AIProvider implements IProvider {
  private readonly model: string;
  private readonly logger?: ILogger;
  private readonly provider: AIProviderInstance;

  constructor(config: ProviderConfig, logger?: ILogger) {
    this.model = config.model;
    this.logger = logger;
    // Create the appropriate Vercel AI SDK provider
    this.provider = createProvider(config);
  }

  /**
   * Converts ChatMessage[] to model message format expected by AI SDK v6
   */
  private toModelMessages(messages: ChatMessage[]): Array<{ role: string; content: string; toolCallId?: string }> {
    return messages.map(msg => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool',
          content: msg.content,
          toolCallId: msg.tool_call_id
        };
      }
      return {
        role: msg.role,
        content: msg.content
      };
    });
  }

  async stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void,
    extraBody?: Record<string, unknown>
  ): Promise<void> {
    try {
      // Get the language model from the provider using the new v6 API
      const languageModel = this.provider(this.model);

      // Convert messages to model message format
      const modelMessages = this.toModelMessages(messages);

      // Use Vercel AI SDK's streamText
      const result = streamText({
        model: languageModel,
        messages: modelMessages as any, // Type assertion needed for v6 message format compatibility
        ...extraBody,
        abortSignal: signal
      });

      // Stream text deltas
      for await (const chunk of result.textStream) {
        onEvent({ type: 'delta', content: chunk });
      }

      // Get usage and finish reason from the result after stream completes
      // In v6, these are PromiseLike and resolve after stream is consumed
      const usage = await result.usage;
      const finishReason = await result.finishReason;

      onEvent({
        type: 'done',
        usage: {
          promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0
        },
        finishReason
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        onEvent({ type: 'done', finishReason: 'aborted' });
        return;
      }

      // Provide a user-friendly error message for common connection issues
      const errMsg = err instanceof Error ? err.message : String(err);
      let friendlyMessage = errMsg;

      // Detect common connection errors
      if (errMsg.includes('fetch failed') ||
        errMsg.includes('ECONNREFUSED') ||
        errMsg.includes('ENOTFOUND') ||
        errMsg.includes('ETIMEDOUT') ||
        errMsg.includes('socket hang up') ||
        errMsg.includes('Connection refused') ||
        errMsg.includes('Connection timed out') ||
        errMsg.includes('getaddrinfo')) {
        friendlyMessage = `Cannot connect to LLM server.\n\n` +
          'Please ensure your LLM server is running.\n' +
          'You can start it with: `llama-server --model <model> --port 8083`\n' +
          'Or check your settings: File > Preferences > Settings > Agent 86';
      }

      onEvent({ type: 'error', message: friendlyMessage });
    }
  }
}
