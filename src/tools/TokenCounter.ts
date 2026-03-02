import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { Tokenizer } from '@huggingface/tokenizers';
import { ChatMessage } from '../providers/IProvider';
import { ILogger } from '../providers/IProvider';

/**
 * Downloads and caches a Hugging Face tokenizer, then counts tokens accurately.
 * Falls back to char/4 heuristic if the tokenizer cannot be loaded.
 */
export class TokenCounter {
  private _tokenizer: Tokenizer | undefined;
  private _loadPromise: Promise<void> | undefined;
  private _modelId: string | undefined;

  constructor(
    private readonly _cacheDir: string,
    private readonly _log?: ILogger
  ) {}

  /**
   * Initiate background loading of the tokenizer for the given HuggingFace model ID.
   * Safe to call multiple times; re-loads only when the model ID changes.
   */
  load(hfModelId: string): void {
    if (this._modelId === hfModelId && (this._tokenizer || this._loadPromise)) {
      return;
    }
    this._modelId = hfModelId;
    this._tokenizer = undefined;
    this._loadPromise = this._loadTokenizer(hfModelId);
  }

  /** Count tokens in a set of chat messages; falls back to char/4 if tokenizer unavailable. */
  async countMessages(messages: ChatMessage[]): Promise<number> {
    const text = messages.map(m => m.content ?? '').join('\n');
    return this.countText(text);
  }

  /** Count tokens in a string; falls back to char/4 if tokenizer unavailable. */
  async countText(text: string): Promise<number> {
    if (this._loadPromise) {
      await this._loadPromise;
    }
    if (this._tokenizer) {
      try {
        const enc = this._tokenizer.encode(text);
        return enc.ids.length;
      } catch (err) {
        this._log?.appendLine(`[TokenCounter] encode error: ${err}`);
      }
    }
    return Math.round(text.length / 4);
  }

  /** True if the real tokenizer is loaded and ready. */
  get isReady(): boolean {
    return !!this._tokenizer;
  }

  private async _loadTokenizer(modelId: string): Promise<void> {
    const cacheKey = modelId.replace(/\//g, '__');
    const tokFile = path.join(this._cacheDir, `${cacheKey}__tokenizer.json`);
    const cfgFile = path.join(this._cacheDir, `${cacheKey}__tokenizer_config.json`);

    try {
      fs.mkdirSync(this._cacheDir, { recursive: true });

      let tokJson: object;
      let cfgJson: object;

      if (fs.existsSync(tokFile) && fs.existsSync(cfgFile)) {
        this._log?.appendLine(`[TokenCounter] loading cached tokenizer for ${modelId}`);
        tokJson = JSON.parse(fs.readFileSync(tokFile, 'utf8'));
        cfgJson = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      } else {
        this._log?.appendLine(`[TokenCounter] downloading tokenizer for ${modelId}…`);
        const base = `https://huggingface.co/${modelId}/resolve/main`;
        [tokJson, cfgJson] = await Promise.all([
          fetchJson(`${base}/tokenizer.json`),
          fetchJson(`${base}/tokenizer_config.json`),
        ]);
        fs.writeFileSync(tokFile, JSON.stringify(tokJson));
        fs.writeFileSync(cfgFile, JSON.stringify(cfgJson));
        this._log?.appendLine(`[TokenCounter] tokenizer cached to ${this._cacheDir}`);
      }

      this._tokenizer = new Tokenizer(tokJson, cfgJson);
      this._log?.appendLine(`[TokenCounter] tokenizer ready for ${modelId}`);
    } catch (err) {
      this._log?.appendLine(`[TokenCounter] failed to load tokenizer for ${modelId}: ${err} — using char/4 fallback`);
    }
  }
}

function fetchJson(url: string): Promise<object> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    (lib as typeof https).get(url, { headers: { 'User-Agent': 'agent-86' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        fetchJson(next).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}
