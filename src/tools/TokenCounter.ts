import { countTokens } from '@anthropic-ai/tokenizer';
import { ChatMessage } from '../providers/IProvider';

/**
 * Counts tokens using the bundled Anthropic tokenizer (no network requests).
 * Falls back to char/4 heuristic on error.
 */
export class TokenCounter {
  /** Count tokens in a set of chat messages. */
  async countMessages(messages: ChatMessage[]): Promise<number> {
    const text = messages.map(m => m.content ?? '').join('\n');
    return this.countText(text);
  }

  /** Count tokens in a string. */
  async countText(text: string): Promise<number> {
    try {
      return countTokens(text);
    } catch {
      return Math.round(text.length / 4);
    }
  }

  /** Always true — tokenizer is bundled and immediately available. */
  get isReady(): boolean {
    return true;
  }
}
