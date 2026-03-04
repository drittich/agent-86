import { streamText, ToolSet } from 'ai';
import { IProvider, ChatMessage, ProviderEvent, StreamOptions } from './IProvider';
import { ProviderConfig } from '../config/ConfigManager';
import { createProvider, AIProviderInstance } from './ProviderFactory';

/**
 * AIProvider wraps the Vercel AI SDK to provide streaming chat completions.
 * Supports multiple providers (OpenAI, Anthropic, OpenRouter, OpenAI-compatible)
 * via auto-detection from the base URL.
 *
 * When `toolUse` is enabled and tools are provided, uses native tool calling via
 * `fullStream` and emits `tool-call` events. Falls back to text-only streaming
 * when `toolUse` is false (for models that don't support tool calling).
 */
export class AIProvider implements IProvider {
  private readonly model: string;
  private readonly provider: AIProviderInstance;
  private readonly toolUse: boolean;

  constructor(config: ProviderConfig, _logger?: unknown) {
    this.model = config.model;
    this.toolUse = config.toolUse ?? true;
    this.provider = createProvider(config);
  }

  /**
   * Converts ChatMessage[] to model message format expected by AI SDK v6.
   * Tool messages carry toolCallId for proper assistant↔tool pairing.
   */
  private toModelMessages(messages: ChatMessage[]): Array<any> {
    return messages.map(msg => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool',
          content: msg.content,
          toolCallId: msg.tool_call_id
        };
      }
      // Assistant messages with tool calls need toolCalls preserved for the SDK
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content ?? '',
          toolCalls: msg.tool_calls.map(tc => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input
          }))
        };
      }
      return {
        role: msg.role,
        content: msg.content ?? ''
      };
    });
  }

  async stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void,
    options?: StreamOptions
  ): Promise<void> {
    try {
      const languageModel = this.provider(this.model);
      const modelMessages = this.toModelMessages(messages);

      // Use native tool calling only if enabled AND tools are provided
      const useNativeTools = this.toolUse && options?.tools && Object.keys(options.tools).length > 0;

      const streamArgs: Parameters<typeof streamText>[0] = {
        model: languageModel,
        messages: modelMessages as any,
        abortSignal: signal,
        ...(options?.extraBody ?? {})
      };

      if (useNativeTools) {
        streamArgs.tools = options!.tools as ToolSet;
        // Don't set stopWhen — we manage the loop ourselves in ChatPanel
      }

      const result = streamText(streamArgs);

      if (useNativeTools) {
        // Consume fullStream to get both text deltas and tool calls
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              onEvent({ type: 'delta', content: part.text });
              break;
            case 'tool-call':
              if (!('dynamic' in part) || !part.dynamic) {
                // Static tool call — input is typed
                onEvent({
                  type: 'tool-call',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: (part as any).input as Record<string, unknown>
                });
              }
              break;
            case 'error':
              onEvent({ type: 'error', message: String((part as any).error ?? 'Unknown stream error') });
              break;
          }
        }
      } else {
        // Fallback: text-only streaming (models without tool support)
        for await (const chunk of result.textStream) {
          onEvent({ type: 'delta', content: chunk });
        }
      }

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

      const errMsg = err instanceof Error ? err.message : String(err);
      let friendlyMessage = errMsg;

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
