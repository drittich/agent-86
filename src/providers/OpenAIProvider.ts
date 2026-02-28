import { IProvider, ChatMessage, ProviderEvent, ProviderUsage } from './IProvider';

export class OpenAIProvider implements IProvider {
  constructor(
    private readonly baseURL: string,
    private readonly model: string,
    private readonly apiKey: string = 'local'
  ) {}

  async stream(
    messages: ChatMessage[],
    signal: AbortSignal,
    onEvent: (event: ProviderEvent) => void
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: 2048,
        }),
        signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        onEvent({ type: 'done' });
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
        friendlyMessage = `Cannot connect to LLM server at ${this.baseURL}.\n\n` +
          'Please ensure your LLM server is running.\n' +
          'You can start it with: `llama-server --model <model> --port 8083`\n' +
          'Or check your settings: File > Preferences > Settings > Agent 86';
      }
      
      onEvent({ type: 'error', message: friendlyMessage });
      return;
    }

    if (!response.ok) {
      onEvent({ type: 'error', message: `HTTP ${response.status}: ${response.statusText}` });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onEvent({ type: 'error', message: 'No response body' });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let usage: ProviderUsage | undefined;
    let deltaCount = 0;
    let rawLineCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Log raw buffer content for debugging (first chunk only)
        if (rawLineCount === 0) {
          console.error(`[OpenAIProvider] First chunk bytes: ${value.length}, buffer preview: ${buffer.slice(0, 500)}`);
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          rawLineCount++;
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            console.error(`[OpenAIProvider] SSE done. rawLines=${rawLineCount}, deltas=${deltaCount}`);
            onEvent({ type: 'done', usage });
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              deltaCount++;
              onEvent({ type: 'delta', content: delta });
            } else if (json?.choices?.[0]?.delta) {
              // Log delta objects that have no content (may have other fields like role, refusal)
              console.error(`[OpenAIProvider] delta without content: ${JSON.stringify(json.choices[0].delta)}`);
            }
            // Log the full JSON structure for the first few frames to understand the format
            if (rawLineCount <= 5) {
              console.error(`[OpenAIProvider] frame ${rawLineCount}: ${JSON.stringify(json).slice(0, 500)}`);
            }
            // Capture usage data when present (some servers send it on the last frame)
            if (json?.usage) {
              usage = {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
                totalTokens: json.usage.total_tokens ?? 0,
              };
            }
          } catch (parseErr) {
            // Log malformed SSE frames for debugging
            console.error(`[OpenAIProvider] Failed to parse SSE data: ${data.slice(0, 200)}`);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        onEvent({ type: 'done', usage });
        return;
      }
      onEvent({ type: 'error', message: String(err) });
    } finally {
      reader.releaseLock();
    }

    onEvent({ type: 'done', usage });
  }
}
