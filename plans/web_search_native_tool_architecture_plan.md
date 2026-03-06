# Architecture plan: `web_search` native tool for an agentic coding extension

## Goal

Build a native `web_search` tool that returns candidate URLs for the agent to inspect with `fetch_url`, using a free-first approach:

- DuckDuckGo Lite for general web discovery
- GitHub Search API as fallback
- deterministic query rewriting for v1
- strict search/fetch budgets
- ranking tuned for coding tasks

---

## Core design principle

Split discovery from grounding:

- `web_search` discovers and ranks URLs
- `fetch_url` reads actual page content
- the model reasons over fetched pages, not search snippets alone

That means `web_search` should return a compact, normalized list of candidate URLs plus ranking metadata, while `fetch_url` remains the only page-reading primitive.

---

## High-level architecture

### 1. Native tools

Implement these tools:

#### `web_search`

Input:

```ts
{
  query: string,
  intent?: "reference" | "implementation" | "debugging" | "comparison" | "general",
  max_results?: number
}
```

Output:

```ts
{
  rewritten_queries: string[],
  candidates: Array<{
    title: string,
    url: string,
    snippet?: string,
    domain: string,
    source: "duckduckgo_lite" | "github_repo_search" | "github_code_search",
    score: number,
    reason?: string
  }>,
  fetched: Array<{
    url: string,
    title?: string,
    domain: string,
    source: string
  }>,
  budget: {
    max_search_calls: 2,
    max_fetches: 3,
    search_calls_used: number,
    fetches_used: number
  }
}
```

#### Existing `fetch_url`

No change required beyond making sure the agent knows `fetch_url` is the tool for reading page content.

---

## Search pipeline

### Step 1. Classify the request

Before rewriting queries, classify the user request into one of these categories:

- **reference**: asks what an API/feature is or how it works
- **implementation**: asks how to build something
- **debugging**: contains an error, failure, stack trace, or broken behavior
- **comparison**: compares tools, frameworks, libraries, or approaches
- **general**: anything else

This classification should be deterministic in v1, using lightweight rules.

### Step 2. Rewrite into 2–3 queries

Do **not** call an LLM first for this. Start with deterministic query templates.

Generate up to 3 query types:

#### A. Official-docs query

Purpose: primary sources and API docs

Template examples:

- `{topic} official docs`
- `site:{official_domain} {topic}` when the ecosystem is known
- `{library} {feature} official docs`

#### B. Code-example query

Purpose: GitHub examples, sample repos, reference implementations

Template examples:

- `github {topic} example`
- `{topic} sample code`
- `{framework} {feature} github example`

#### C. Problem-solution query

Purpose: troubleshooting, tutorials, issue threads

Template examples:

- `{topic} how to implement`
- `"{exact_error}" {library}` for debugging
- `{topic} issue fix`

Rules:

- Use **3 queries** for implementation/debugging tasks
- Use **2 queries** for simple reference tasks when official docs and examples are sufficient
- Preserve exact quoted error text for debugging
- Add version terms only if the user explicitly mentions a version

---

## Should query rewriting use an LLM?

### Recommendation

**No for v1. Maybe later for v2.**

Use deterministic rules first because they are:

- faster
- cheaper
- easier to debug
- easier to test
- good enough for coding tasks

### Deterministic rewrite approach

Build a small `rewriteQueries()` module that:

1. tokenizes the user request
2. detects coding intent
3. detects likely ecosystem or official domain
4. emits 2–3 templated queries

Example: User: `how do I add semantic tokens in a VS Code extension`

Generated queries:

- `vscode semantic tokens extension official docs`
- `github vscode semantic tokens example`
- `how to implement vscode semantic tokens extension`

### Optional v2

Later, you can add an LLM rewrite pass only when:

- deterministic results are weak
- the request is unusually ambiguous
- the first search round has low confidence

But keep that behind a flag or fallback path.

---

## DuckDuckGo Lite integration

Use DuckDuckGo Lite as the default free search backend.

Endpoint pattern:

```txt
https://lite.duckduckgo.com/lite/?q=QUERY
```

Implementation notes:

- fetch raw HTML
- parse result links, titles, and snippets
- normalize redirect URLs if present
- cap collected raw results at about 8 per query

Per-query budget:

- collect up to **8 results per query**
- run **2 or 3 queries total**
- initial search round should normally use **1 search call** to your native tool, not multiple model-level tool calls

---

## GitHub fallback

If DuckDuckGo Lite produces weak or sparse results, use GitHub as fallback.

### Endpoints

Repository search:

```txt
https://api.github.com/search/repositories?q=QUERY
```

Code search:

```txt
https://api.github.com/search/code?q=QUERY
```

### When to use fallback

Trigger GitHub fallback when one or more of these is true:

- fewer than 3 good candidates after ranking
- the request is clearly code-example heavy
- the request names a library/framework and asks for implementation details
- DuckDuckGo results are dominated by weak blogs or SEO pages

### GitHub fallback policy

- repo search is preferred for examples and official repos
- code search is useful for exact APIs, filenames, config keys, and concrete patterns
- do not let GitHub fallback exceed the overall `max_search_calls = 2`

---

## Ranking and filtering

After collecting results from all search backends, normalize and rank them.

### Hard filters

Apply these before scoring:

- remove invalid URLs
- remove obvious non-HTML landing pages where not useful
- dedupe near-identical URLs
- **max 1 result per domain**

### Preference rules

Prefer:

1. official docs
2. official GitHub repos
3. reputable vendor/standards docs
4. strong community answers/tutorials

### Scoring signals

Use a simple additive scoring model.

#### Positive signals

- official domain match
- GitHub repo/result
- strong title keyword overlap
- snippet keyword overlap
- url contains feature/API terms
- page looks like docs/reference/example/sample
- exact error text match for debugging

#### Negative signals

- obvious listicle/SEO phrases
- duplicate domain after first accepted result
- irrelevant generic blogs
- pages that look like aggregators/scrapers

### Example scoring skeleton

```ts
score = 0
+ 50 official docs domain
+ 35 github.com
+ 20 exact title match
+ 10 snippet overlap
+ 10 example/sample/demo
+ 15 exact error text match
- 20 listicle/spam
- 15 duplicate/near-duplicate content
```

### Domain constraint

Because you want **max 1 result per domain**, implement this in ranking selection rather than early deletion:

- sort all candidates by score
- walk the sorted list
- keep the first candidate from each domain
- stop when you have the desired shortlist

---

## Fetch policy

After reranking, fetch the top few pages with your existing `fetch_url` tool.

### Limits

- `max_fetches = 3`
- fetch only the top 3 candidates initially
- if the agent already used 3 fetches, it must synthesize from existing content rather than continue fetching

### Selection strategy

Prefer a diverse top 3 mix when possible:

- 1 official docs page
- 1 GitHub repo or code example
- 1 troubleshooting/community page if relevant

### Why fetch after ranking

This keeps network cost low and ensures the agent reasons over page content, not search snippets.

---

## Search loop limits

Enforce these budgets inside tool orchestration and in the prompt:

- `max_search_calls = 2`
- `max_fetches = 3`

### Recommended behavior

- first search round: 2–3 rewritten queries via DuckDuckGo Lite
- second and final search round only if confidence is low
- final round may refine the best query or use GitHub fallback

### Confidence heuristics for allowing a second search call

Allow one additional search call only if:

- no official docs were found for a known ecosystem
- fewer than 2 high-confidence candidates remain after reranking
- fetched pages do not answer the question well

Otherwise, do not continue searching.

---

## Suggested modules

### `intentClassifier.ts`

Classifies query into reference / implementation / debugging / comparison / general.

### `queryRewriter.ts`

Builds official-docs, code-example, and problem-solution queries using deterministic templates.

### `duckduckgoLiteSearch.ts`

Fetches and parses DuckDuckGo Lite result pages.

### `githubFallbackSearch.ts`

Calls GitHub repo/code search endpoints when needed.

### `normalizeResults.ts`

Maps raw search results into a common schema.

### `rankResults.ts`

Scores candidates and selects max one per domain.

### `fetchPlanner.ts`

Chooses up to 3 URLs to pass to `fetch_url`.

### `budgetManager.ts`

Tracks `max_search_calls` and `max_fetches`.

---

## Recommended execution flow

```txt
User request
  -> classify intent
  -> rewrite into 2 or 3 queries
  -> DuckDuckGo Lite search for each query
  -> normalize + merge results
  -> rerank results
  -> enforce max 1 result per domain
  -> if weak, do one fallback search call (refined query or GitHub)
  -> choose top 3 URLs
  -> fetch_url on top URLs
  -> model answers from fetched content
```

---

## System prompt update

Add guidance like this:

```txt
You can use the `web_search` tool to discover relevant URLs when external information is needed.

Use `web_search` primarily for coding and technical questions that may require current documentation, examples, issue threads, or reference material.

When external information is needed:
1. Generate up to 3 search queries:
   - official docs query
   - code examples query
   - troubleshooting query (if relevant)
2. Search and collect up to 8 results per query.
3. Prefer official docs, official repos, and exact-match technical pages.
4. Deduplicate results and avoid fetching multiple near-identical pages.
5. Fetch at most 3 pages initially.
6. If confidence remains low, perform at most 1 additional search with a refined query.

Budget limits:
- max_search_calls = 2
- max_fetches = 3

Selection rules:
- prefer official docs
- prefer GitHub repos
- keep at most 1 result per domain

Important:
- Use `web_search` for discovery, then use `fetch_url` to read actual page content.
- Do not rely on search snippets alone when answering.
```

---

## Prompt guidance for coding tasks vs general Q&A

You asked how the model should generate search queries differently for coding tasks.

### Recommendation

Handle this with a mix of:

- system prompt guidance
- lightweight intent classification in your tool layer
- deterministic query rewriting rules

### Coding-task behavior

For coding tasks, bias queries toward:

- official docs
- GitHub examples
- exact API names
- exact error strings
- framework/library names
- version numbers only when explicitly relevant

Examples:

- `react useEffect cleanup official docs`
- `github vscode semantic tokens example`
- `"cannot find module vite/client" vite`

### General Q&A behavior

For general Q&A, use broader search phrasing and reduce GitHub bias.

Examples:

- `what is X official docs`
- `X overview`
- `X how it works`

### Practical answer to your question

No, you do **not** need to call an LLM just to decide this in v1. Use deterministic routing:

- if the query mentions code, APIs, frameworks, config, files, errors, stack traces, or implementation verbs, treat it as coding
- otherwise treat it as general

Optional LLM classification can be added later, but it is not necessary to ship a strong first version.

---

## Suggested rollout plan

### Phase 1 ✅ COMPLETE

- DuckDuckGo Lite search
- deterministic query rewriting
- ranking + domain dedupe
- fetch top 3
- system prompt update

### Phase 2

- GitHub fallback
- stronger ecosystem-to-official-domain mapping
- better debugging/error query handling

### Phase 3

- optional LLM-assisted rewrite when first-pass confidence is low
- fetched-page quality scoring
- learning from past successful sources

---

## Final recommendation

For your first implementation:

- do **not** call an LLM for query rewriting by default
- implement deterministic query rewriting and intent classification
- keep `web_search` as a discovery-and-ranking tool only
- use `fetch_url` as the grounding tool
- enforce strict budgets in both code and prompt

That will give you a clean, cheap, and reliable v1 that is easy to debug and improve.

