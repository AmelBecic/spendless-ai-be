// The IO half of the profiling loop: gather what the agent reads, run it, and
// persist what it wrote. `profile.ts` stays a function of the input it is given,
// the same way `aggregate.ts` stays a function of its ledger.

import type { ProfileSummary, Transaction } from "../domain/types";
import { AppError } from "../http/errors";
import type { ProfilesRepository } from "../repositories/profiles";
import type { TransactionsRepository } from "../repositories/transactions";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
import type { CategoriesRepository } from "../repositories/categories";
import { aggregate, type Period } from "./aggregate";
import { listPeriod, loadLedger } from "./stats";
import { MODEL, type LlmClient } from "./anthropic";
import { runProfileAgent } from "./profile";

export interface ProfileRefreshDeps {
  llm: LlmClient;
  transactions: TransactionsRepository;
  expenses: FixedExpensesRepository;
  profiles: ProfilesRepository;
  summaries: ProfileSummariesRepository;
  /** Read for category labels — the model is shown names, not uuids. */
  categories: CategoriesRepository;
}

/**
 * True when today's summary already exists and nothing has been recorded since
 * it was written, so re-running the model would pay for an identical answer.
 *
 * The comparison is against the summary's `createdAt`, not its `asOfDate`: the
 * question is bookkeeping ("has anything been entered since we last looked?"),
 * which is exactly what a row's insert timestamp answers, and day granularity
 * cannot answer it at all.
 */
function nothingChangedSince(previous: ProfileSummary, transactions: Transaction[]): boolean {
  return transactions.every((tx) => tx.createdAt <= previous.createdAt);
}

/**
 * The window the refresh reports on: month-to-date in UTC, matching what
 * `GET /stats` defaults to. The narrative and the stats screen therefore quote
 * the same totals — a profile describing a different period than the one the
 * user can see would read as a contradiction.
 */
export function profilePeriod(now: Date): Period {
  const end = now.toISOString().slice(0, 10);
  return { start: `${end.slice(0, 7)}-01`, end };
}

const MS_PER_DAY = 86_400_000;

/**
 * How far back a single refresh will reach, however stale the profile is.
 *
 * Without a floor, a user who lapsed for a year comes back to a window spanning
 * that year: `listPeriod` walks it, trips `LedgerTooLargeError`, and the request
 * 422s. Nothing in the flow would ever shrink that window, so every subsequent
 * refresh fails identically and the profile is stuck permanently. Clamping trades
 * the oldest unseen activity — which the previous summary's narrative already
 * carries forward in prose — for a loop that always terminates.
 */
export const MAX_INCREMENTAL_LOOKBACK_DAYS = 60;

/**
 * The slice of activity the model sees: everything from the previous summary's
 * own day onwards, floored at `MAX_INCREMENTAL_LOOKBACK_DAYS` before the period.
 *
 * Inclusive of that day, not the day after it. `asOfDate` has day granularity,
 * so a summary written at midday and refreshed again that evening would
 * otherwise skip the afternoon's spending entirely — the day it names was still
 * accumulating when it was written. Re-showing a transaction the previous pass
 * already saw costs a few tokens; dropping one loses it for good.
 */
export function incrementalWindow(previous: ProfileSummary | null, period: Period): Period | null {
  if (!previous) return period;
  if (previous.asOfDate > period.end) return null;

  const floor = new Date(
    Date.parse(`${period.start}T00:00:00.000Z`) - MAX_INCREMENTAL_LOOKBACK_DAYS * MS_PER_DAY,
  )
    .toISOString()
    .slice(0, 10);
  // Both are `YYYY-MM-DD`, so a string compare is a date compare.
  const start = previous.asOfDate > floor ? previous.asOfDate : floor;
  return { start, end: period.end };
}

/**
 * New transactions for `window`, reusing the ledger the stats were computed from
 * whenever the window sits inside the stats period — which is every refresh of a
 * profile that was last summarised this month. Only a profile left stale across
 * a month boundary pays for a second read.
 */
async function inWindow(
  deps: ProfileRefreshDeps,
  userId: string,
  window: Period | null,
  period: Period,
  periodTransactions: Transaction[],
): Promise<Transaction[]> {
  if (!window) return [];
  if (window.start >= period.start) {
    return periodTransactions.filter((tx) => tx.occurredAt.slice(0, 10) >= window.start);
  }
  return listPeriod(deps.transactions, userId, window);
}

/**
 * Everything the agent should treat as new: the incremental window by
 * `occurredAt`, plus anything *entered* since the previous summary was written.
 *
 * The two halves answer different questions and both are needed. A transaction
 * backdated a week — normal in a spending app, you enter Saturday's coffee on
 * Monday — falls outside a window anchored on `occurredAt`, yet it does move
 * `stats.total` for the period. Without the second half it would never appear in
 * any window, on any future day, while visibly changing the totals the narrative
 * sits next to; and because `nothingChangedSince` judges novelty by `createdAt`,
 * an empty window would even short-circuit the refresh as "nothing changed".
 */
async function newTransactions(
  deps: ProfileRefreshDeps,
  userId: string,
  window: Period | null,
  period: Period,
  periodTransactions: Transaction[],
  previous: ProfileSummary | null,
): Promise<Transaction[]> {
  const windowed = await inWindow(deps, userId, window, period, periodTransactions);
  if (!previous) return windowed;

  const seen = new Set(windowed.map((tx) => tx.id));
  const backdated = periodTransactions.filter(
    (tx) => !seen.has(tx.id) && tx.createdAt > previous.createdAt,
  );
  // Chronological, so the payload reads as a sequence rather than by which half
  // of the union each row came from.
  return [...windowed, ...backdated].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/**
 * Recompute the caller's stats, run the profiling agent over the new activity,
 * and persist the result as today's summary.
 *
 * Throws a 404 when the caller has no profile row — there is then no currency to
 * report in, the same reasoning as `loadLedger`.
 */
export async function refreshProfile(
  deps: ProfileRefreshDeps,
  userId: string,
  now: Date,
): Promise<ProfileSummary> {
  const period = profilePeriod(now);

  // The previous summary is read alongside the ledger: neither depends on the
  // other, and the agent cannot start without both.
  const [ledger, previous] = await Promise.all([
    loadLedger(deps, userId, period),
    deps.summaries.latest(userId),
  ]);
  if (!ledger) throw new AppError(404, "NOT_FOUND", "profile not found");

  const stats = aggregate(period, ledger);
  const window = incrementalWindow(previous, period);
  const transactions = await newTransactions(
    deps,
    userId,
    window,
    period,
    ledger.transactions,
    previous,
  );

  // Cheapest possible guard on a paid endpoint: a caller who refreshes twice with
  // no spending in between gets the row they already have, at the cost of the
  // reads above and no completion at all. A per-user rate limit — the general
  // answer to an unmetered LLM route — is SLAI-19's.
  if (previous && previous.asOfDate === period.end && nothingChangedSince(previous, transactions)) {
    return previous;
  }

  const categories = await deps.categories.list();
  const categoryLabels = Object.fromEntries(categories.map((c) => [c.id, c.label]));

  const result = await runProfileAgent(deps.llm, {
    previous,
    newTransactions: transactions,
    stats,
    categoryLabels,
  });

  return deps.summaries.upsert(userId, {
    asOfDate: new Date(`${period.end}T00:00:00.000Z`),
    summary: result.summary,
    narrative: result.narrative,
    // Recorded per row rather than assumed globally: summaries written by an
    // earlier model stay attributable after the constant moves on.
    model: MODEL,
  });
}
