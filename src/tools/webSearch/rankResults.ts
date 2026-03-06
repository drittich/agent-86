/**
 * Candidate ranking and domain deduplication.
 *
 * Uses a simple additive scoring model. Enforces max 1 result per domain
 * by walking the sorted list and keeping only the highest-ranked result
 * for each domain.
 */

import { NormalizedCandidate } from './normalizeResults';

const OFFICIAL_DOMAINS = new Set([
  'react.dev', 'reactjs.org', 'nextjs.org', 'vuejs.org', 'nuxt.com', 'angular.io',
  'svelte.dev', 'docs.solidjs.com', 'nodejs.org', 'deno.com', 'docs.deno.com',
  'bun.sh', 'typescriptlang.org', 'developer.mozilla.org', 'docs.python.org',
  'docs.djangoproject.com', 'flask.palletsprojects.com', 'fastapi.tiangolo.com',
  'doc.rust-lang.org', 'pkg.go.dev', 'code.visualstudio.com', 'learn.microsoft.com',
  'docs.docker.com', 'kubernetes.io', 'docs.aws.amazon.com', 'cloud.google.com',
  'tailwindcss.com', 'prisma.io', 'graphql.org', 'expressjs.com', 'fastify.dev',
  'jestjs.io', 'vitest.dev', 'webpack.js.org', 'vitejs.dev', 'esbuild.github.io',
  'eslint.org', 'prettier.io', 'docs.astro.build', 'remix.run', 'npmjs.com',
  'docs.github.com', 'git-scm.com', 'pnpm.io', 'yarnpkg.com',
]);

const DOCS_URL_RE = /\/(docs?|reference|guide|api|manual|getting[-_]?started)\//i;
const SPAM_RE = /\b(?:top \d+|best \d+|\d+ (?:ways|tips|tricks|things)|you (?:must|need to) know|free download|buy now|click here)\b/i;

function scoreCandidate(c: NormalizedCandidate, queryTerms: string[]): number {
  let score = 0;
  const title   = c.title.toLowerCase();
  const snippet = (c.snippet ?? '').toLowerCase();
  const url     = c.url.toLowerCase();

  // Positive signals
  if (OFFICIAL_DOMAINS.has(c.domain)) { score += 50; }
  if (c.domain === 'github.com')       { score += 35; }
  if (c.domain === 'stackoverflow.com') { score += 15; }

  const titleHits   = queryTerms.filter(t => title.includes(t)).length;
  score += Math.min(titleHits * 5, 20);

  const snippetHits = queryTerms.filter(t => snippet.includes(t)).length;
  score += Math.min(snippetHits * 2, 10);

  if (DOCS_URL_RE.test(url)) { score += 10; }

  // Negative signals
  if (SPAM_RE.test(title) || SPAM_RE.test(snippet)) { score -= 20; }

  return score;
}

export function rankAndDedup(
  candidates: NormalizedCandidate[],
  queries: string[],
  maxResults = 8
): NormalizedCandidate[] {
  // Flatten query terms, strip site: prefix, skip short tokens
  const allTerms = queries
    .flatMap(q => q.toLowerCase().replace(/^site:\S+\s*/, '').split(/\s+/))
    .filter(t => t.length > 3);

  const scored = candidates.map(c => ({ ...c, score: scoreCandidate(c, allTerms) }));
  scored.sort((a, b) => b.score - a.score);

  const seenDomains = new Set<string>();
  const result: NormalizedCandidate[] = [];

  for (const c of scored) {
    if (!c.domain || seenDomains.has(c.domain)) { continue; }
    seenDomains.add(c.domain);
    result.push(c);
    if (result.length >= maxResults) { break; }
  }

  return result;
}
