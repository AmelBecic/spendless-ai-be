// The data-access seam. Route handlers depend on this bundle and never on Prisma
// directly — every method over user-owned data is scoped to a `userId`, so "which
// user's rows?" is answered once, here, instead of at each call site. The rule is
// enforced by the `@typescript-eslint/no-restricted-imports` rule that bars
// `src/routes/**` from importing the Prisma client at all.
//
// `categories` is the one exception, and deliberately so: it is global read-only
// reference data with no owner and no `userId` column — see ./categories.ts.

import type { PrismaClient } from "@prisma/client";
import { createAgentRunsRepository, type AgentRunsRepository } from "./agent-runs";
import { createCategoriesRepository, type CategoriesRepository } from "./categories";
import { createProfilesRepository, type ProfilesRepository } from "./profiles";
import { createFixedExpensesRepository, type FixedExpensesRepository } from "./fixed-expenses";
import { createTransactionsRepository, type TransactionsRepository } from "./transactions";
import { createSuggestionsRepository, type SuggestionsRepository } from "./suggestions";
import {
  createProfileSummariesRepository,
  type ProfileSummariesRepository,
} from "./profile-summaries";

export interface Repositories {
  categories: CategoriesRepository;
  profiles: ProfilesRepository;
  expenses: FixedExpensesRepository;
  transactions: TransactionsRepository;
  suggestions: SuggestionsRepository;
  summaries: ProfileSummariesRepository;
  agentRuns: AgentRunsRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    agentRuns: createAgentRunsRepository(prisma),
    categories: createCategoriesRepository(prisma),
    profiles: createProfilesRepository(prisma),
    expenses: createFixedExpensesRepository(prisma),
    transactions: createTransactionsRepository(prisma),
    suggestions: createSuggestionsRepository(prisma),
    summaries: createProfileSummariesRepository(prisma),
  };
}

export type { AgentRunsRepository, AgentRunKind } from "./agent-runs";
export type { CategoriesRepository } from "./categories";
export type { ProfilesRepository, ProfilePatch, ListUserIdsOptions } from "./profiles";
export type {
  FixedExpensesRepository,
  CreateFixedExpenseInput,
  UpdateFixedExpenseInput,
  ListFixedExpensesOptions,
} from "./fixed-expenses";
export type {
  TransactionsRepository,
  CreateTransactionInput,
  UpdateTransactionInput,
  ListTransactionsOptions,
} from "./transactions";
export type {
  SuggestionsRepository,
  CreateSuggestionInput,
  ListSuggestionsOptions,
} from "./suggestions";
export type { ProfileSummariesRepository, UpsertProfileSummaryInput } from "./profile-summaries";
export type { Page } from "./shared";
