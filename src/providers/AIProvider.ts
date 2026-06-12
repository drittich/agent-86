import { streamText, ToolSet, RetryError } from 'ai';
import { IProvider, ChatMessage, ProviderEvent, StreamOptions } from './IProvider';
import { ProviderConfig } from '../config/ConfigManager';
import { createProvider, AIProviderInstance } from './ProviderFactory';

/**
 * Extracts the root cause error from AI SDK error wrappers.
 * AI SDK wraps errors in RetryError which contains lastError.
 */
export function extractRootError(error: unknown): unknown {
	// Handle AI SDK RetryError - extract the last error
	if (RetryError.isInstance(error)) {
		if (error.lastError) {
			return extractRootError(error.lastError);
		}
	}
	return error;
}

/**
 * Checks if an error indicates the model doesn't support tool/function calling at all.
 * Matches patterns from OpenRouter, Ollama, and other providers.
 */
export function isToolSupportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /400.*\b(tool|function|parameter)\b/i.test(msg) ||
    /\btools?\s+(not\s+supported|are\s+not\s+supported|unsupported)\b/i.test(msg) ||
    /\b(invalid|unsupported)\s+(tool|function)\b/i.test(msg) ||
    /invalid character.*looking for.*tools/i.test(msg) ||
    /invalid character.*after top-level value/i.test(msg)
  );
}

/**
 * Checks if an error indicates the model doesn't support the Responses API
 * and should fall back to Chat Completions API.
 */
function isResponsesAPIError(err: unknown): boolean {
  const errMsg = err instanceof Error ? err.message : String(err);
  return errMsg.includes('Invalid Responses API') ||
    errMsg.includes('No output generated') ||
    errMsg.includes('Responses API') ||
    errMsg.includes('invalid_response');
}

/**
 * AIProvider wraps the Vercel AI SDK to provide streaming chat completions.
 * Supports multiple providers (OpenAI, Anthropic, OpenRouter, OpenAI-compatible)
 * via auto-detection from the base URL.
 *
 * When tools are provided via StreamOptions, uses native tool calling via
 * `fullStream` and emits `tool-call` events. Falls back to text-only streaming
 * when no tools are passed (the caller decides based on the auto-detected
 * tool-support verdict for the model).
 *
 * Auto-detects Responses API incompatibility and falls back to Chat Completions.
 */
export class AIProvider implements IProvider {
  private readonly model: string;
  private readonly config: ProviderConfig;
  // Lazily initialized on first stream() call via createProvider()
  private _provider: AIProviderInstance | undefined;
  private _chatCompletionsProvider: AIProviderInstance | undefined;

  constructor(config: ProviderConfig, _logger?: unknown) {
    this.model = config.model;
    this.config = config;
  }

  /**
   * Gets or initializes the primary provider (lazy, async).
   */
  private async getProvider(): Promise<AIProviderInstance> {
    if (!this._provider) {
      this._provider = await createProvider(this.config);
    }
    return this._provider;
  }

  /**
   * Gets or creates a provider that uses Chat Completions API (fallback for models
   * that don't support the Responses API).
   */
  private async getChatCompletionsProvider(): Promise<AIProviderInstance> {
    if (!this._chatCompletionsProvider) {
      this._chatCompletionsProvider = await createProvider({
        ...this.config,
        // Force Chat Completions API instead of Responses API
        useChatCompletions: true
      });
    }
    return this._chatCompletionsProvider;
  }

  /**
   * Converts ChatMessage[] to model message format expected by AI SDK v6.
   * Follows nanocoder's approach: preserve rich assistant/tool content parts
   * so fallback mode keeps full conversational context.
   */
  private toModelMessages(messages: ChatMessage[], preserveToolCalls: boolean): Array<any> {
    const result: Array<any> = [];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.tool_call_id ?? '',
              toolName: '',
              output: {
                type: 'text',
                value: msg.content ?? ''
              }
            }
          ]
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const contentParts: Array<any> = [];
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          contentParts.push({
            type: 'text',
            text: msg.content
          });
        }

        if (preserveToolCalls && msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            contentParts.push({
              type: 'tool-call',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input
            });
          }
        }

        // Skip assistant messages with no serializable content — don't emit a blank turn.
        if (contentParts.length === 0) {
          continue;
        }

        result.push({
          role: 'assistant',
          content: contentParts
        });
        continue;
      }

      result.push({
        role: msg.role,
        content: msg.content ?? ''
      });
    }
    return result;
  }

  private isEmptyAssistantMessage(message: ChatMessage): boolean {
    if (message.role !== 'assistant') {
      return false;
    }
    const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
    const hasToolCalls = !!message.tool_calls && message.tool_calls.length > 0;
    return !hasContent && !hasToolCalls;
  }

  /**
   * Remove invalid/unsupported message shapes before sending to the model:
   * - empty assistant messages
   * - orphaned tool messages that follow empty assistant messages
   */
  private sanitizeConversation(messages: ChatMessage[]): ChatMessage[] {
    const skipIndices = new Set<number>();
    for (let i = 0; i < messages.length; i++) {
      if (this.isEmptyAssistantMessage(messages[i])) {
        skipIndices.add(i);
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          skipIndices.add(j);
          j++;
        }
      }
    }
    return messages.filter((_, i) => !skipIndices.has(i));
  }

  async stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void,
    options?: StreamOptions
  ): Promise<void> {
    // Try with default provider (Responses API), fall back to Chat Completions on error
    await this.doStream(await this.getProvider(), messages, signal, onEvent, options, false);
  }

  /**
   * Internal stream implementation with fallback support.
   * @param provider The AI provider to use
   * @param messages Chat messages
   * @param signal Abort signal
   * @param onEvent Event callback
   * @param options Stream options
   * @param isFallback Whether this is a fallback attempt after Responses API failure
   * @returns true if a Responses API error was detected and caller should retry
   */
  private async doStream(
    provider: AIProviderInstance,
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void,
    options?: StreamOptions,
    isFallback: boolean = false
  ): Promise<void> {
    // Track stream errors for fallback detection
    let streamError: string | null = null;
    let hasContent = false;

    try {
      const languageModel = provider(this.model);

      // Use native tool calling whenever tools are provided
      const useNativeTools = !!options?.tools && Object.keys(options.tools).length > 0;
      // Sanitize before sending: remove empty assistant messages and orphaned tool results.
      // Keep full conversation history regardless of native-tools mode so fallback requests
      // retain prior tool context (native tool calls and tool results).
      const sanitizedMessages = this.sanitizeConversation(messages);
      const modelMessages = this.toModelMessages(sanitizedMessages, true);

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
              hasContent = true;
              onEvent({ type: 'delta', content: part.text });
              break;
            case 'tool-call':
              hasContent = true;
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
              // Capture error for fallback detection - don't emit yet
              streamError = String((part as any).error ?? 'Unknown stream error');
              break;
          }
        }
      } else {
        // Fallback: text-only streaming (models without tool support)
        for await (const chunk of result.textStream) {
          hasContent = true;
          onEvent({ type: 'delta', content: chunk });
        }
      }

      const usage = await result.usage;
      const finishReason = await result.finishReason;

      // Check if model doesn't support tool calling at all
      if (streamError && !hasContent && isToolSupportError(streamError)) {
        onEvent({ type: 'tool-unsupported' });
        return;
      }

      // Check if we got a Responses API error with no content
      console.log('[AIProvider] streamError:', streamError, 'hasContent:', hasContent, 'isFallback:', isFallback, 'isResponsesAPIError:', isFallback ? false : isResponsesAPIError(streamError));
      if (streamError && !hasContent && !isFallback && isResponsesAPIError(streamError)) {
        // Retry with Chat Completions API
        console.log('[AIProvider] Responses API error detected, falling back to Chat Completions');
        await this.doStream(await this.getChatCompletionsProvider(), messages, signal, onEvent, options, true);
        return;
      }

      // If we have a stream error and no content, emit the error
      if (streamError && !hasContent) {
        onEvent({ type: 'error', message: streamError });
        return;
      }

      // If we have content but also an error, emit the error after content (non-fatal)
      if (streamError && hasContent) {
        onEvent({ type: 'error', message: streamError });
      }

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

      // AI SDK wraps errors in RetryError - extract the root error first
      const rootError = extractRootError(err);

      // Check if model doesn't support tool calling at all
      if (isToolSupportError(rootError ?? err)) {
        onEvent({ type: 'tool-unsupported' });
        return;
      }

      // Check for AI_NoOutputGeneratedError - model returned empty response
      if (rootError instanceof Error && 
          (rootError.name === 'AI_NoOutputGeneratedError' || 
           rootError.message.includes('No output generated'))) {
        // Check if there's an underlying API error
        if (rootError !== err) {
          // There's a real error underneath - check if it's a Responses API error
          if (!isFallback && isResponsesAPIError(rootError)) {
            console.log('[AIProvider] Responses API error (from NoOutputGeneratedError), falling back to Chat Completions');
            await this.doStream(await this.getChatCompletionsProvider(), messages, signal, onEvent, options, true);
            return;
          }
        }
        // No underlying error or not a Responses API error - emit as empty response
        console.log('[AIProvider] AI_NoOutputGeneratedError (silent empty):', rootError.message);
        onEvent({ type: 'done', finishReason: 'stop' });
        return;
      }

      // If this is already a fallback attempt or not a Responses API error, report the error
      if (isFallback || !isResponsesAPIError(err)) {
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
        return;
      }

      // Responses API error - try fallback with Chat Completions
      console.log('[AIProvider] Responses API error in catch, falling back to Chat Completions');
      await this.doStream(await this.getChatCompletionsProvider(), messages, signal, onEvent, options, true);
    }
  }
}
