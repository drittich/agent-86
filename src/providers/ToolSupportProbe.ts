import { generateText, jsonSchema, tool } from 'ai';
import { ProviderConfig } from '../config/ConfigManager';
import { createProvider } from './ProviderFactory';
import { extractRootError, isToolSupportError } from './AIProvider';
import { ILogger } from './IProvider';

/**
 * One-time behavioral probe for native tool-calling support.
 *
 * Error-based detection (isToolSupportError) only catches servers that reject
 * the `tools` parameter. Local servers like LM Studio and llama.cpp accept it,
 * inject the schemas into the prompt template, and models not trained for
 * function calling (e.g. Gemma) simply never produce a call. The only reliable
 * test is to ask for one: send a single tiny request with one trivial tool and
 * check whether a structured tool call comes back.
 */

const PROBE_TOOLS = {
  ping: tool({
    description: 'Echo back the provided text. Call this tool to confirm tool calling works.',
    inputSchema: jsonSchema<{ text: string }>({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back.' }
      },
      required: ['text']
    })
  })
};

const PROBE_PROMPT = 'Call the ping tool with text="ok". Respond only by calling the tool, not with text.';
const PROBE_TIMEOUT_MS = 30_000;

/**
 * 'native'  — the model produced a structured tool call.
 * 'legacy'  — the model ignored the tools or the server rejected them.
 * 'unknown' — the probe couldn't run (server down, timeout); don't cache.
 */
export type ToolSupportVerdict = 'native' | 'legacy' | 'unknown';

/** Cache key for a tool-support verdict: one verdict per server+model pair. */
export function toolSupportKey(config: Pick<ProviderConfig, 'baseUrl' | 'model'>): string {
  return `${config.baseUrl}::${config.model}`;
}

/**
 * Probes whether the model produces a native tool call for a trivial prompt.
 *
 * Returns 'unknown' on timeouts and network errors so a transient outage is
 * not cached as a permanent verdict — the caller should treat 'unknown' as
 * native for the current turn and re-probe next time.
 */
export async function probeToolSupport(config: ProviderConfig, log?: ILogger): Promise<ToolSupportVerdict> {
  const key = toolSupportKey(config);
  try {
    const provider = await createProvider(config);
    const result = await generateText({
      model: provider(config.model),
      tools: PROBE_TOOLS,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      // Headroom for models that emit reasoning text before the call
      maxOutputTokens: 512,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    const called = result.toolCalls?.some(tc => tc.toolName === 'ping') ?? false;
    log?.appendLine(
      `[probe] ${key}: ${called
        ? 'native tool call received'
        : `no tool call (text: ${JSON.stringify((result.text ?? '').slice(0, 100))})`}`
    );
    return called ? 'native' : 'legacy';
  } catch (err) {
    const root = extractRootError(err);
    if (isToolSupportError(root ?? err)) {
      log?.appendLine(`[probe] ${key}: server rejected tools param — ${root instanceof Error ? root.message : String(root)}`);
      return 'legacy';
    }
    log?.appendLine(`[probe] ${key}: probe inconclusive (${err instanceof Error ? err.message : String(err)})`);
    return 'unknown';
  }
}
