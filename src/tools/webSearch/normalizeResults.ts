import { RawSearchResult } from './duckduckgoLiteSearch';

export interface NormalizedCandidate {
  title: string;
  url: string;
  snippet?: string;
  domain: string;
  source: 'duckduckgo_lite';
  score: number;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function normalizeResults(raw: RawSearchResult[]): NormalizedCandidate[] {
  return raw
    .filter(r => { try { new URL(r.url); return true; } catch { return false; } })
    .map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      domain: extractDomain(r.url),
      source: r.source,
      score: 0,
    }));
}
