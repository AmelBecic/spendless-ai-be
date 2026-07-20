// The IO half of the suggestion loop: gather what the agent reads, run it, and
// persist what it produced. `suggest.ts` stays a function of its input, the same
// way `aggregate.ts` stays a function of its ledger.

import type { Suggestion } from "../domain/types";
import { AppError } from "../http/errors";
import type { AgentRunsRepository } from "../repositories/agent-runs";
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
import { hasAnythingToAdvise, runSuggestionAgent, suggestibleExpenses } from "./suggest";

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
  /** Records that a pass ran, independently of what it wrote — see below. */
  agentRuns: AgentRunsRepository;
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

  // The rows above are only half the guard. A pass whose proposals were all
  // dropped — or that found nothing to advise — writes no rows, so it leaves
  // nothing for the check above to short-circuit on and every retry that day
  // buys another completion. The user likeliest to produce no suggestions is
  // therefore the one who pays most. `agentRuns` records *that* a pass ran,
  // independently of its output, which is the only thing that closes it.
  if (await deps.agentRuns.hasRun(userId, "suggestions", asOfDate)) return [];

  // Neither read depends on the other, and the agent cannot start without both.
  const [ledger, profile] = await Promise.all([
    loadLedger(deps, userId, period),
    deps.summaries.latest(userId),
  ]);
  if (!ledger) throw new AppError(404, "NOT_FOUND", "profile not found");

  const stats = aggregate(period, ledger);
  const discretionary = discretionaryByCategory(ledger.transactions, ledger.currency);
  const suggestible = suggestibleExpenses(ledger.fixedExpenses, ledger.currency);

  // Nothing to trim and nothing to cancel, so there is no suggestion the model
  // could ground in anything. Worth checking explicitly: a user with an empty or
  // near-empty ledger is both the likeliest to produce no suggestions *and* the
  // one whose every retry would otherwise buy a completion that returns nothing.
  //
  // It does not close the hole entirely — a pass whose proposals are all dropped
  // still writes no rows, so the day never gets a set to short-circuit on and the
  // next refresh pays again. Recording "a pass ran today" independently of its
  // output needs a row this schema has no table for; that belongs with the rest
  // of the cost guardrails in SLAI-19.
  if (!hasAnythingToAdvise(discretionary, suggestible)) return [];

  const categories = await deps.categories.list();
  const categoryLabels = Object.fromEntries(categories.map((c) => [c.id, c.label]));

  const result = await runSuggestionAgent(deps.llm, {
    profile,
    stats,
    discretionaryByCategory: discretionary,
    fixedExpenses: ledger.fixedExpenses,
    categoryLabels,
  });

  // Recorded *after* the call, not before it, and deliberately so.
  //
  // As a pre-claim this would double as a mutex, and the loser of a race would
  // have to be handed an empty list — but the day's set is already serialised on
  // the user's row inside `createDailySet`, which hands the loser the winner's
  // rows instead. Two racing refreshes are a rate limit's problem; what this row
  // exists for is the *next* attempt, hours later, which must not re-buy a pass
  // that already ran and legitimately produced nothing.
  //
  // Recording only on success is the other half: a pass that threw never happened
  // as far as this table is concerned, so a transient failure costs a retry
  // rather than the user's whole day.
  await deps.agentRuns.claim(userId, "suggestions", asOfDate);

  // Surfaced, not swallowed: a model that has started citing targets it was
  // never shown is a prompt regression whose only other symptom is a short list.
  if (result.dropped.length > 0) {
    deps.logger.warn(
      { userId, dropped: result.dropped, kept: result.suggestions.length },
      "discarded ungrounded suggestions",
    );
  }

  // Written as one atomic set. The check above is only a fast path — two
  // refreshes racing past it would both land here, and the repository is what
  // decides which one's rows the user actually keeps.
  return deps.suggestions.createDailySet(
    userId,
    asOfDate,
    result.suggestions.map((suggestion) => ({
      asOfDate,
      text: suggestion.text,
      categoryId: suggestion.categoryId,
      estMonthlySavingsCents: suggestion.estMonthlySavings.amountCents,
      currency: suggestion.estMonthlySavings.currency,
      rationale: suggestion.rationale,
      sourceRefs: suggestion.sourceRefs,
    })),
  );
}
