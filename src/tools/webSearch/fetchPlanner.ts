/**
 * Selects up to maxFetches URLs for immediate fetch_url calls.
 * Tries to return a diverse mix: 1 official docs page, 1 GitHub result, then others.
 */

import { NormalizedCandidate } from './normalizeResults';

const DOCS_URL_RE = /\/(docs?|reference|guide|api)\//i;
const DOCS_DOMAIN_RE = /(?:^docs?\.|^developer\.|^learn\.)/;

function isDocPage(c: NormalizedCandidate): boolean {
  return DOCS_URL_RE.test(c.url) || DOCS_DOMAIN_RE.test(c.domain);
}

export function planFetches(candidates: NormalizedCandidate[], maxFetches = 3): NormalizedCandidate[] {
  const docs   = candidates.filter(c => isDocPage(c));
  const github = candidates.filter(c => c.domain === 'github.com');
  const other  = candidates.filter(c => !isDocPage(c) && c.domain !== 'github.com');

  const selected: NormalizedCandidate[] = [];
  const add = (c: NormalizedCandidate) => {
    if (selected.length < maxFetches && !selected.includes(c)) { selected.push(c); }
  };

  // Preferred order: docs → github → other → fill from top candidates
  if (docs[0])   { add(docs[0]); }
  if (github[0]) { add(github[0]); }
  for (const c of other)       { add(c); }
  for (const c of candidates)  { add(c); } // fill any remaining slots

  return selected;
}
