// The IO half of the suggestion loop: gather what the agent reads, run it, and
// persist what it produced. `suggest.ts` stays a function of its input, the same
// way `aggregate.ts` stays a function of its ledger.

import type { Suggestion } from "../domain/types";
import { AppError } from "../http/errors";
import type { CategoriesRepository } from "../repositories/categories";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfilesRepository } from "../repositories/profiles";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
import type { SuggestionsRepository } from "../repositories/suggestions";
import type { TransactionsRepository } from "../repositories/transactions";
import { aggregate, discretionaryByCategory } from "./aggregate";
import { profilePeriod } from "./profile-refresh";
import { loadLedger } from "./stats";
import type { LlmClient } from "./anthropic";
import { runSuggestionAgent } from "./suggest";

/** Minimal logging surface, matching the LLM seam's — no coupling to Fastify. */
export interface SuggestLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface SuggestRefreshDeps {
  llm: LlmClient;
  transactions: TransactionsRepository;
  expenses: FixedExpensesRepository;
  profiles: ProfilesRepository;
  summaries: ProfileSummariesRepository;
  suggestions: SuggestionsRepository;
  /** Read for category labels — the model is shown names, not bare uuids. */
  categories: CategoriesRepository;
  logger: SuggestLogger;
}

/**
 * Produce today's suggestions for a user, or return the ones already produced.
 *
 * One set per user per day, mirroring the profile summary's shape. The day's
 * existing set short-circuits the model call: a second refresh on the same
 * ledger would pay for near-identical advice, and re-running it after the user
 * has dismissed something would quietly resurrect it.
 *
 * Throws a 404 when the caller has no profile row — there is then no currency to
 * price a saving in, the same reasoning as `loadLedger`.
 */
export async function refreshSuggestions(
  deps: SuggestRefreshDeps,
  userId: string,
  now: Date,
): Promise<Suggestion[]> {
  const period = profilePeriod(now);
  const asOfDate = new Date(`${period.end}T00:00:00.000Z`);

  const existing = await deps.suggestions.list(userId, { asOfDate });
  if (existing.items.length > 0) return existing.items;

  // Neither read depends on the other, and the agent cannot start without both.
  const [ledger, profile] = await Promise.all([
    loadLedger(deps, userId, period),
    deps.summaries.latest(userId),
  ]);
  if (!ledger) throw new AppError(404, "NOT_FOUND", "profile not found");

  const stats = aggregate(period, ledger);
  const categories = await deps.categories.list();
  const categoryLabels = Object.fromEntries(categories.map((c) => [c.id, c.label]));

  const result = await runSuggestionAgent(deps.llm, {
    profile,
    stats,
    discretionaryByCategory: discretionaryByCategory(ledger.transactions, ledger.currency),
    fixedExpenses: ledger.fixedExpenses,
    categoryLabels,
  });

  // Surfaced, not swallowed: a model that has started citing targets it was
  // never shown is a prompt regression whose only other symptom is a short list.
  if (result.dropped.length > 0) {
    deps.logger.warn(
      { userId, dropped: result.dropped, kept: result.suggestions.length },
      "discarded ungrounded suggestions",
    );
  }

  // Sequential rather than concurrent: a handful of inserts, and one failing
  // mid-batch should not leave a half-written set behind further writes.
  const created: Suggestion[] = [];
  for (const suggestion of result.suggestions) {
    created.push(
      await deps.suggestions.create(userId, {
        asOfDate,
        text: suggestion.text,
        categoryId: suggestion.categoryId,
        estMonthlySavingsCents: suggestion.estMonthlySavings.amountCents,
        currency: suggestion.estMonthlySavings.currency,
        rationale: suggestion.rationale,
        sourceRefs: suggestion.sourceRefs,
      }),
    );
  }
  return created;
}
