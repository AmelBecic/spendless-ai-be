// Repository stubs for tests that must satisfy buildApp's `repos` contract
// without exercising it — health, 404 and auth paths never reach a data route.

import type { CategoriesRepository } from "../repositories/categories";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { TransactionsRepository } from "../repositories/transactions";
import type { ProfilesRepository } from "../repositories/profiles";

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

export const emptyCategories: CategoriesRepository = { list: async () => [] };

/** The `repos` bundle for tests that drive no repository-backed route. */
export const unusedRepos = {
  categories: emptyCategories,
  expenses: unusedFixedExpenses,
  transactions: unusedTransactions,
  profiles: unusedProfiles,
};
