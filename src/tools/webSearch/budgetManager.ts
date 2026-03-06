export interface SearchBudget {
  maxSearchCalls: number;
  maxFetches: number;
  searchCallsUsed: number;
  fetchesUsed: number;
}

export function createBudget(): SearchBudget {
  return { maxSearchCalls: 2, maxFetches: 3, searchCallsUsed: 0, fetchesUsed: 0 };
}

/** Consume one search call. Returns false if over budget. */
export function consumeSearch(budget: SearchBudget): boolean {
  if (budget.searchCallsUsed >= budget.maxSearchCalls) { return false; }
  budget.searchCallsUsed++;
  return true;
}
