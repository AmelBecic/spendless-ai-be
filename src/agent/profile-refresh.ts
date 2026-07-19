// The IO half of the profiling loop: gather what the agent reads, run it, and
// persist what it wrote. `profile.ts` stays a function of the input it is given,
// the same way `aggregate.ts` stays a function of its ledger.

import type { ProfileSummary, Transaction } from "../domain/types";
import { AppError } from "../http/errors";
import type { ProfilesRepository } from "../repositories/profiles";
import type { TransactionsRepository } from "../repositories/transactions";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
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

/**
 * The slice of activity the model sees: everything from the previous summary's
 * own day onwards.
 *
 * Inclusive of that day, not the day after it. `asOfDate` has day granularity,
 * so a summary written at midday and refreshed again that evening would
 * otherwise skip the afternoon's spending entirely — the day it names was still
 * accumulating when it was written. Re-showing a transaction the previous pass
 * already saw costs a few tokens; dropping one loses it for good.
 */
export function incrementalWindow(previous: ProfileSummary | null, period: Period): Period | null {
  if (!previous) return period;
  const start = previous.asOfDate;
  if (start > period.end) return null;
  return { start, end: period.end };
}

/**
 * New transactions for `window`, reusing the ledger the stats were computed from
 * whenever the window sits inside the stats period — which is every refresh of a
 * profile that was last summarised this month. Only a profile left stale across
 * a month boundary pays for a second read.
 */
async function newTransactions(
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
  const transactions = await newTransactions(deps, userId, window, period, ledger.transactions);

  const result = await runProfileAgent(deps.llm, {
    previous,
    newTransactions: transactions,
    stats,
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
