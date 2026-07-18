// Repository stubs for tests that must satisfy buildApp's `repos` contract
// without exercising it — health, 404 and auth paths never reach a data route.

import type { CategoriesRepository } from "../repositories/categories";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";

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

export const emptyCategories: CategoriesRepository = { list: async () => [] };

/** The `repos` bundle for tests that drive no repository-backed route. */
export const unusedRepos = { categories: emptyCategories, expenses: unusedFixedExpenses };
