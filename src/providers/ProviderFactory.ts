import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { ProviderConfig } from '../config/ConfigManager';

/**
 * Union type representing any Vercel AI SDK provider instance.
 * Different providers (OpenAI, Anthropic, etc.) have different interfaces,
 * so we use a union to handle them all.
 */
export type AIProviderInstance = ReturnType<typeof createOpenAI> | ReturnType<typeof createAnthropic>;

/**
 * Detects which Vercel AI SDK provider factory to use from URL.
 */
function detectProviderFromUrl(baseUrl: string): string {
  const url = baseUrl.toLowerCase();

  // Anthropic - MUST use createAnthropic() due to different API structure
  if (url.includes('anthropic.com')) {
    return 'anthropic';
  }

  // OpenRouter - uses OpenAI-compatible API but different auth
  if (url.includes('openrouter.ai')) {
    return 'openrouter';
  }

  // OpenAI
  if (url.includes('api.openai.com')) {
    return 'openai';
  }

  // Default: OpenAI-compatible (local endpoints, custom servers)
  return 'openai-compatible';
}

/**
 * Creates a Vercel AI SDK provider instance based on configuration.
 * Auto-detects provider from URL - no explicit provider type needed.
 */
export function createProvider(config: ProviderConfig): AIProviderInstance {
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

    case 'openrouter':
      // OpenRouter uses OpenAI-compatible API but with different auth headers
      // Use custom headers required by OpenRouter
      return createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://openrouter.ai/api/v1',
        headers: {
          'HTTP-Referer': 'https://agent86.darcy.dev',
          'X-Title': 'Agent 86'
        }
      });

    case 'openai':
    case 'openai-compatible':
    default:
      // OpenAI and all OpenAI-compatible endpoints use createOpenAI()
      // This includes: OpenAI, local LLMs (llama-server, LM Studio, Ollama), custom endpoints
      return createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.openai.com/v1'
      });
  }
}
