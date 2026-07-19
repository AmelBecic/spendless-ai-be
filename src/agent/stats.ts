// The IO half of the stats layer: gather a user's ledger through the repository
// seam so `aggregate` can stay a pure function of what came back. Nothing here
// computes a total.

import type { Transaction } from "../domain/types";
import type { TransactionsRepository } from "../repositories/transactions";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfilesRepository } from "../repositories/profiles";
import { MAX_PAGE_SIZE } from "../repositories/shared";
import { previousPeriod, type Ledger, type Period } from "./aggregate";

export interface LedgerDeps {
  transactions: TransactionsRepository;
  expenses: FixedExpensesRepository;
  /** Read for the caller's currency — the denomination every figure is reported in. */
  profiles: ProfilesRepository;
}

/**
 * Ceiling on how many transactions a single request will aggregate. A total has
 * to cover the whole period or it is simply wrong, so this cannot truncate
 * quietly the way a paged listing can — it throws, and the caller narrows the
 * window.
 */
export const MAX_LEDGER_TRANSACTIONS = 10_000;

/** Thrown when a period holds more transactions than one request will aggregate. */
export class LedgerTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Period holds more than ${limit} transactions — request a narrower period`);
    this.name = "LedgerTooLargeError";
    this.limit = limit;
  }
}

/**
 * Every transaction in a window. The repository is paged by design — the table
 * grows with each day of use — but a total over one page would be a wrong
 * number, so walk the cursor to the end.
 */
async function listPeriod(
  repo: TransactionsRepository,
  userId: string,
  period: Period,
): Promise<Transaction[]> {
  // The bounds are inclusive on both sides: midnight is already right for the
  // lower one, while the upper has to cover the whole day it names or the
  // period's last 24 hours go missing from the total.
  const from = new Date(`${period.start}T00:00:00.000Z`);
  const to = new Date(`${period.end}T23:59:59.999Z`);

  const items: Transaction[] = [];
  let cursor: string | undefined;

  do {
    const page = await repo.list(userId, { from, to, limit: MAX_PAGE_SIZE, cursor });
    // An empty page ends the walk whatever the cursor says. The row cap below
    // bounds how much is collected, not how many times we go round, so a cursor
    // that stops advancing — a filtered or racing implementation returning no
    // rows alongside a non-null cursor — would otherwise spin here forever,
    // holding a connection and never reaching the cap.
    if (page.items.length === 0) break;

    items.push(...page.items);
    if (items.length > MAX_LEDGER_TRANSACTIONS) {
      throw new LedgerTooLargeError(MAX_LEDGER_TRANSACTIONS);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return items;
}

/**
 * Gather everything `aggregate` needs for `period`, including the previous
 * comparable window that the month-over-month delta rests on.
 *
 * Returns `null` when the caller has no profile row: there is then no currency
 * to report in, and inventing one would put a label on a total that nothing
 * backs. (Auth provisions the row on first sight, so in practice this means it
 * was deleted mid-request.)
 */
export async function loadLedger(
  deps: LedgerDeps,
  userId: string,
  period: Period,
): Promise<Ledger | null> {
  const profile = await deps.profiles.get(userId);
  if (!profile) return null;

  // Fixed expenses come back unfiltered — `aggregate` decides which applied to
  // which window, and needs the inactive ones visible to do it.
  const [transactions, previousTransactions, fixedExpenses] = await Promise.all([
    listPeriod(deps.transactions, userId, period),
    listPeriod(deps.transactions, userId, previousPeriod(period)),
    deps.expenses.list(userId),
  ]);

  return { currency: profile.currency, transactions, previousTransactions, fixedExpenses };
}
