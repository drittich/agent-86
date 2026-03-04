import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { ProviderConfig } from '../config/ConfigManager';

/**
 * Extended provider config that includes useChatCompletions option.
 */
export interface OpenAIProviderConfig extends ProviderConfig {
  /** Force use of Chat Completions API instead of Responses API */
  useChatCompletions?: boolean;
}

/**
 * Union type representing any Vercel AI SDK provider instance.
 * Different providers (OpenAI, Anthropic, etc.) have different interfaces,
 * so we use a union to handle them all.
 */
export type AIProviderInstance = ReturnType<typeof createOpenAICompatible> | ReturnType<typeof createOpenAI> | ReturnType<typeof createAnthropic>;

/**
 * Detects which Vercel AI SDK provider factory to use from URL.
 */
function detectProviderFromUrl(baseUrl: string): string {
  const url = baseUrl.toLowerCase();

  // Anthropic - MUST use createAnthropic() due to different API structure
  if (url.includes('anthropic.com')) {
    return 'anthropic';
  }

  // OpenAI - use createOpenAI() for official OpenAI API
  if (url.includes('api.openai.com')) {
    return 'openai';
  }

  // OpenRouter and all other OpenAI-compatible endpoints use createOpenAICompatible()
  // This includes: OpenRouter, local LLMs (llama-server, LM Studio, Ollama), custom endpoints
  return 'openai-compatible';
}

/**
 * Creates a Vercel AI SDK provider instance based on configuration.
 * Auto-detects provider from URL - no explicit provider type needed.
 */
export function createProvider(config: OpenAIProviderConfig): AIProviderInstance {
  const baseUrl = config.baseUrl;
  const apiKey = config.apiKey ?? 'local';

  // Detect which Vercel AI SDK factory to use from URL
  const providerType = detectProviderFromUrl(baseUrl);

  switch (providerType) {
    case 'anthropic':
      // Anthropic requires createAnthropic() - different API structure
      return createAnthropic({
        apiKey,
        baseURL: baseUrl || 'https://api.anthropic.com'
      });

    case 'openai':
      // Official OpenAI API uses createOpenAI()
      return createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.openai.com/v1'
      });

    case 'openai-compatible':
    default:
      // OpenAI-compatible endpoints use createOpenAICompatible()
      // This includes: OpenRouter, local LLMs (llama-server, LM Studio, Ollama), custom endpoints
      // createOpenAICompatible defaults to Chat Completions API, avoiding Responses API issues
      return createOpenAICompatible({
        name: config.name || 'openai-compatible',
        apiKey,
        baseURL: baseUrl || 'http://127.0.0.1:8083/v1'
      });
  }
}
