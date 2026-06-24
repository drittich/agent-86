import { ModelTier } from './ModelProfile';

/**
 * DeepSeek V4 (via OpenRouter) integration helpers.
 *
 * We reach `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` through
 * OpenRouter, which is OpenAI-Chat-Completions-shaped. That means thinking is
 * controlled by OpenRouter's unified top-level `reasoning` object — NOT
 * DeepSeek's raw `reasoning_effort`/`thinking` extra_body, and NOT the
 * `chat_template_kwargs.enable_thinking` field used by local llama.cpp/Qwen
 * servers. These helpers centralize the model detection, prompt-profile
 * selection, and request-body construction so ChatPanel stays thin.
 */

/** Graded thinking level, mapped to OpenRouter reasoning effort. */
export type ThinkingLevel = 'off' | 'high' | 'max';

/** Prompt-profile delta key, matching files in `prompts/profiles/`. */
export type ProfileKey = 'deepseek-pro' | 'deepseek-flash';

/** True when the configured model is a DeepSeek V4 model reached via OpenRouter. */
export function isDeepSeekV4(model: string | undefined): boolean {
  return !!model && model.toLowerCase().includes('deepseek-v4');
}

/**
 * Resolve which prompt-profile delta to append for the active model.
 *
 * Matches the OpenRouter IDs `deepseek/deepseek-v4-pro` / `-flash`. For an
 * ambiguous `deepseek-v4` name, falls back to the configured tier (high → pro,
 * otherwise flash). Returns null for non-DeepSeek models so no delta is
 * appended (other providers are unaffected).
 */
export function resolveProfileKey(model: string | undefined, tier: ModelTier): ProfileKey | null {
  if (!model) {
    return null;
  }
  const m = model.toLowerCase();
  if (m.includes('deepseek-v4-pro')) {
    return 'deepseek-pro';
  }
  if (m.includes('deepseek-v4-flash')) {
    return 'deepseek-flash';
  }
  if (m.includes('deepseek-v4')) {
    return tier === 'high' ? 'deepseek-pro' : 'deepseek-flash';
  }
  return null;
}

/**
 * Build the OpenRouter request-body fields for a DeepSeek V4 turn:
 * - graded `reasoning` (disabled / high effort / xhigh effort), and
 * - provider routing pinned to DeepSeek so its on-disk context cache is
 *   reachable and the `reasoning` param is honored (allow_fallbacks: false
 *   prevents silent routing to a non-caching upstream).
 *
 * DeepSeek "high" ≈ OpenRouter `high`; DeepSeek "max" ≈ OpenRouter `xhigh`.
 */
export function buildDeepSeekExtraBody(level: ThinkingLevel): Record<string, unknown> {
  const reasoning =
    level === 'off'
      ? { enabled: false }
      : { effort: level === 'max' ? 'xhigh' : 'high' };

  return {
    reasoning,
    provider: {
      order: ['DeepSeek'],
      allow_fallbacks: false,
      require_parameters: true,
    },
  };
}
