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
      onEvent({ type: 'error', message: String(err) });
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            onEvent({ type: 'done', usage });
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              onEvent({ type: 'delta', content: delta });
            }
            // Capture usage data when present (some servers send it on the last frame)
            if (json?.usage) {
              usage = {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
                totalTokens: json.usage.total_tokens ?? 0,
              };
            }
          } catch {
            // Ignore malformed SSE frames
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
