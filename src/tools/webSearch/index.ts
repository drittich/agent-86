/**
 * Web search pipeline orchestrator — Phase 1.
 *
 * Execution flow:
 *   user query
 *     → classify intent
 *     → rewrite into 2–3 deterministic queries
 *     → DuckDuckGo Lite search (all queries in parallel)
 *     → normalize + merge results
 *     → rank + domain-dedup
 *     → plan fetches (top 3 diverse URLs)
 *     → return structured output
 *
 * The caller (ToolExecutor) is responsible for calling fetch_url on
 * the suggestedFetches to ground the model in actual page content.
 */

import { classifyIntent, SearchIntent } from './intentClassifier';
import { rewriteQueries } from './queryRewriter';
import { searchDuckDuckGoLite, HttpGetFn, RawSearchResult } from './duckduckgoLiteSearch';
import { normalizeResults, NormalizedCandidate } from './normalizeResults';
import { rankAndDedup } from './rankResults';
import { planFetches } from './fetchPlanner';
import { createBudget, consumeSearch } from './budgetManager';

export type { HttpGetFn, SearchIntent };
export type { NormalizedCandidate };

export interface WebSearchInput {
  query: string;
  intent?: SearchIntent;
  max_results?: number;
}

export interface WebSearchOutput {
  intent: SearchIntent;
  rewrittenQueries: string[];
  candidates: NormalizedCandidate[];
  suggestedFetches: string[];
  searchCallsUsed: number;
  maxSearchCalls: number;
  maxFetches: number;
}

export async function runWebSearch(input: WebSearchInput, httpGet: HttpGetFn): Promise<WebSearchOutput> {
  const budget = createBudget();
  const intent = input.intent ?? classifyIntent(input.query);
  const queries = rewriteQueries(input.query, intent);
  const maxResults = Math.min(20, Math.max(1, input.max_results ?? 8));

  consumeSearch(budget);

  // Run all rewritten queries in parallel within the single tool invocation
  const rawBatches = await Promise.all(queries.map(q => searchDuckDuckGoLite(q, httpGet)));
  const allRaw: RawSearchResult[] = rawBatches.flat();

  const normalized = normalizeResults(allRaw);
  const ranked = rankAndDedup(normalized, queries, maxResults);
  const fetchTargets = planFetches(ranked, budget.maxFetches);

  return {
    intent,
    rewrittenQueries: queries,
    candidates: ranked,
    suggestedFetches: fetchTargets.map(c => c.url),
    searchCallsUsed: budget.searchCallsUsed,
    maxSearchCalls: budget.maxSearchCalls,
    maxFetches: budget.maxFetches,
  };
}

export function formatWebSearchOutput(query: string, output: WebSearchOutput): string {
  const lines: string[] = [];

  lines.push(`Web search: "${query}" (intent: ${output.intent})`);
  lines.push('');

  lines.push(`Queries sent (${output.rewrittenQueries.length}):`);
  output.rewrittenQueries.forEach((q, i) => { lines.push(`  ${i + 1}. ${q}`); });
  lines.push('');

  if (output.candidates.length === 0) {
    lines.push('No results found. Try rephrasing the query or use fetch_url with a known URL.');
  } else {
    lines.push(`Candidates (${output.candidates.length}, ranked by relevance, max 1 per domain):`);
    output.candidates.forEach((c, i) => {
      lines.push(`  ${i + 1}. [${c.score}] ${c.domain} — ${c.title}`);
      lines.push(`       ${c.url}`);
      if (c.snippet) {
        lines.push(`       ${c.snippet.slice(0, 200)}${c.snippet.length > 200 ? '…' : ''}`);
      }
    });
  }

  if (output.suggestedFetches.length > 0) {
    lines.push('');
    lines.push(`Suggested fetches (use fetch_url to read full content, max ${output.maxFetches}):`);
    output.suggestedFetches.forEach((url, i) => { lines.push(`  ${i + 1}. ${url}`); });
  }

  lines.push('');
  lines.push(`Budget: ${output.searchCallsUsed}/${output.maxSearchCalls} search calls used.`);

  return lines.join('\n');
}
