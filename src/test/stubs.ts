// Repository stubs for tests that must satisfy buildApp's `repos` contract
// without exercising it — health, 404 and auth paths never reach a data route.

import type { CategoriesRepository } from "../repositories/categories";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { TransactionsRepository } from "../repositories/transactions";
import type { ProfilesRepository } from "../repositories/profiles";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
import type { SuggestionsRepository } from "../repositories/suggestions";
import type { LlmClient } from "../agent/anthropic";

/**
 * A repository whose every method throws. If a test that claims not to touch
 * data ever does, it fails loudly here rather than passing against a silent
 * empty result that hides the call.
 */
export const unusedFixedExpenses: FixedExpensesRepository = {
  list: () => Promise.reject(new Error("fixed expenses repository used unexpectedly")),
  findById: () => Promise.reject(new Error("fixed expenses repository used unexpectedly")),
  create: () => Promise.reject(new Error("fixed expenses repository used unexpectedly")),
  update: () => Promise.reject(new Error("fixed expenses repository used unexpectedly")),
  deactivate: () => Promise.reject(new Error("fixed expenses repository used unexpectedly")),
};

export const unusedTransactions: TransactionsRepository = {
  list: () => Promise.reject(new Error("transactions repository used unexpectedly")),
  findById: () => Promise.reject(new Error("transactions repository used unexpectedly")),
  create: () => Promise.reject(new Error("transactions repository used unexpectedly")),
  update: () => Promise.reject(new Error("transactions repository used unexpectedly")),
  delete: () => Promise.reject(new Error("transactions repository used unexpectedly")),
};

export const unusedProfiles: ProfilesRepository = {
  ensure: () => Promise.reject(new Error("profiles repository used unexpectedly")),
  get: () => Promise.reject(new Error("profiles repository used unexpectedly")),
  update: () => Promise.reject(new Error("profiles repository used unexpectedly")),
};

export const unusedSummaries: ProfileSummariesRepository = {
  latest: () => Promise.reject(new Error("profile summaries repository used unexpectedly")),
  upsert: () => Promise.reject(new Error("profile summaries repository used unexpectedly")),
};

export const unusedSuggestions: SuggestionsRepository = {
  list: () => Promise.reject(new Error("suggestions repository used unexpectedly")),
  findById: () => Promise.reject(new Error("suggestions repository used unexpectedly")),
  create: () => Promise.reject(new Error("suggestions repository used unexpectedly")),
  setStatus: () => Promise.reject(new Error("suggestions repository used unexpectedly")),
};

export const emptyCategories: CategoriesRepository = { list: async () => [] };

/**
 * An LLM that refuses to be called. A test that reaches the model without saying
 * so is either spending real tokens or asserting against a stub it forgot to
 * configure — both fail here instead of passing quietly.
 */
export const unusedLlm: LlmClient = {
  complete: () => Promise.reject(new Error("llm client used unexpectedly")),
};

/**
 * The nth entry of a recorded call log. Tests that assert on what a stub was
 * called with index into an array the compiler cannot prove is long enough;
 * this fails with the count it actually saw rather than at a later assertion
 * with no explanation.
 */
export function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected at least ${index + 1} recorded call(s), got ${items.length}`);
  }
  return item;
}

/** The `repos` bundle for tests that drive no repository-backed route. */
export const unusedRepos = {
  categories: emptyCategories,
  expenses: unusedFixedExpenses,
  transactions: unusedTransactions,
  profiles: unusedProfiles,
  summaries: unusedSummaries,
  suggestions: unusedSuggestions,
};
