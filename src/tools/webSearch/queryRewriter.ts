/**
 * Deterministic query rewriting — generates 2–3 search queries from a user query.
 *
 * Query types:
 *   A. Official-docs query  — primary sources, API references
 *   B. Code-example query   — GitHub examples and repos
 *   C. Problem-solution query — debugging/implementation guidance (intent-gated)
 */

import { SearchIntent } from './intentClassifier';

/** Ecosystem keyword → official docs domain mapping. Order matters: more specific first. */
const OFFICIAL_DOMAINS: [string, string][] = [
  ['next.js',     'nextjs.org'],
  ['nextjs',      'nextjs.org'],
  ['nuxt',        'nuxt.com'],
  ['angular',     'angular.io'],
  ['svelte',      'svelte.dev'],
  ['solidjs',     'docs.solidjs.com'],
  ['react',       'react.dev'],
  ['vue',         'vuejs.org'],
  ['typescript',  'typescriptlang.org'],
  ['javascript',  'developer.mozilla.org'],
  ['deno',        'docs.deno.com'],
  ['node.js',     'nodejs.org'],
  ['nodejs',      'nodejs.org'],
  ['bun',         'bun.sh'],
  ['django',      'docs.djangoproject.com'],
  ['flask',       'flask.palletsprojects.com'],
  ['fastapi',     'fastapi.tiangolo.com'],
  ['python',      'docs.python.org'],
  ['rust',        'doc.rust-lang.org'],
  ['golang',      'pkg.go.dev'],
  ['vscode',      'code.visualstudio.com'],
  ['docker',      'docs.docker.com'],
  ['kubernetes',  'kubernetes.io/docs'],
  ['k8s',         'kubernetes.io/docs'],
  ['tailwind',    'tailwindcss.com'],
  ['prisma',      'prisma.io/docs'],
  ['graphql',     'graphql.org'],
  ['express',     'expressjs.com'],
  ['fastify',     'fastify.dev'],
  ['vitest',      'vitest.dev'],
  ['jest',        'jestjs.io'],
  ['webpack',     'webpack.js.org'],
  ['vite',        'vitejs.dev'],
  ['esbuild',     'esbuild.github.io'],
  ['eslint',      'eslint.org'],
  ['prettier',    'prettier.io'],
  ['astro',       'docs.astro.build'],
  ['remix',       'remix.run/docs'],
  ['aws',         'docs.aws.amazon.com'],
  ['azure',       'learn.microsoft.com/azure'],
  ['gcp',         'cloud.google.com/docs'],
];

function detectOfficialDomain(query: string): string | null {
  const lower = query.toLowerCase();
  for (const [keyword, domain] of OFFICIAL_DOMAINS) {
    if (lower.includes(keyword)) { return domain; }
  }
  return null;
}

export function rewriteQueries(query: string, intent: SearchIntent): string[] {
  const officialDomain = detectOfficialDomain(query);
  const queries: string[] = [];

  // A: Official docs
  if (officialDomain) {
    queries.push(`site:${officialDomain} ${query}`);
  } else {
    queries.push(`${query} official docs`);
  }

  // B: Code examples
  queries.push(`github ${query} example`);

  // C: Problem-solution (only for implementation and debugging)
  if (intent === 'debugging') {
    const quoted = query.match(/"[^"]{3,}"/);
    queries.push(quoted ? `${quoted[0]} fix solution` : `${query} fix solution`);
  } else if (intent === 'implementation') {
    queries.push(`${query} tutorial guide`);
  }

  return queries;
}
