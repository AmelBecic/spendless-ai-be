// The deterministic arithmetic layer. Every figure the agent will later narrate
// is computed here, and only here — the LLM reads these numbers but never
// produces them.
//
// Everything in this file is a pure function of its arguments: no clock, no
// repository, no network. The ledger arrives already fetched (see ./stats.ts),
// so the same ledger and period always yield byte-identical stats — which is
// what makes a stat citable in a suggestion later on.

import type {
  Cadence,
  CategoryTotal,
  FixedExpense,
  Money,
  SpendStats,
  Transaction,
} from "../domain/types";
import { MixedCurrencyError, add, sum } from "../domain/money";

/** An inclusive window of whole UTC days, as ISO `YYYY-MM-DD` dates. */
export interface Period {
  start: string;
  end: string;
}

/** Everything the aggregation reads, already gathered through the repositories. */
export interface Ledger {
  /** The currency every amount is expected to be in — the user's profile currency. */
  currency: string;
  /** Transactions that occurred within the period. */
  transactions: Transaction[];
  /** Transactions of the previous comparable window; feeds the delta only. */
  previousTransactions: Transaction[];
  /** The user's fixed expenses. Which of them apply to a window is decided here. */
  fixedExpenses: FixedExpense[];
}

const MS_PER_DAY = 86_400_000;

/** How many entries `topCategories` keeps. */
export const TOP_CATEGORY_COUNT = 5;

// Average calendar lengths, so any cadence converts to a comparable daily rate.
// 365.25 carries the leap year; the monthly figure is that over twelve months
// rather than a nominal 30, so a year of monthly rent sums to twelve payments.
const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  monthly: 365.25 / 12,
  yearly: 365.25,
};

function startOfDay(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Inclusive day count: a period whose start and end name the same day is 1. */
export function periodDays(period: Period): number {
  const start = startOfDay(period.start);
  const end = startOfDay(period.end);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new TypeError(`Period bounds must be ISO dates, got ${period.start}..${period.end}`);
  }
  const days = (end - start) / MS_PER_DAY + 1;
  if (days < 1) {
    throw new RangeError(`Period end ${period.end} precedes start ${period.start}`);
  }
  return days;
}

/**
 * The window of the same length ending the day before `period` starts. Equal
 * lengths are what make the delta a comparison rather than an artefact — against
 * a fixed "previous calendar month" a 10-day window would always look cheaper.
 */
export function previousPeriod(period: Period): Period {
  const days = periodDays(period);
  const end = startOfDay(period.start) - MS_PER_DAY;
  return { start: toIsoDate(end - (days - 1) * MS_PER_DAY), end: toIsoDate(end) };
}

/**
 * Every amount must be in the ledger's currency. Checked before any arithmetic
 * runs: `sum` would catch two transactions disagreeing with each other, but not
 * a ledger uniformly in USD reported under a profile that says EUR — the total
 * would be right and its label wrong, which is the harder error to notice.
 */
function assertSingleCurrency(currency: string, amounts: Money[]): void {
  for (const money of amounts) {
    if (money.currency !== currency) {
      throw new MixedCurrencyError(currency, money.currency);
    }
  }
}

/**
 * The fixed expenses that count towards a window: the active ones, whichever
 * window it is.
 *
 * `createdAt` is deliberately *not* consulted. It records when the row was
 * entered, not when the commitment began, and the two are rarely the same — a
 * user typing in the rent they have paid for years creates that row today.
 * Filtering on it was tried and produces the worse error by far: every period
 * before the row's creation reports zero recurring spend, so a freshly onboarded
 * user's entire history looks rent-free.
 *
 * That leaves two known distortions, in opposite directions, and both are the
 * same missing column rather than a filter that could be made cleverer:
 *
 * - A genuinely new commitment is charged to earlier windows too, so it cancels
 *   out of `momDeltaCents` instead of showing up as an increase.
 * - `active` is read as though it had always been true. Cancelling a gym
 *   membership today empties it out of the months it was demonstrably paid,
 *   changing stats for periods that have already closed — so a figure here is
 *   reproducible from a given ledger, but not stable across edits to that
 *   ledger.
 *
 * Fixing either needs `startedAt`/`endedAt` on a fixed expense. Until the schema
 * carries them, treating the active set as a standing rate is the honest
 * reading; anything else invents a date the database does not have.
 */
export function activeExpenses(expenses: FixedExpense[]): FixedExpense[] {
  return expenses.filter((expense) => expense.active);
}

/**
 * A fixed expense's share of a window, prorated through a daily rate so windows
 * of any length stay comparable. A monthly commitment therefore contributes
 * marginally more over a 31-day month than a 28-day one: the figure is a spend
 * *rate* attributed to the period, not a copy of the bill.
 */
export function proratedCents(expense: FixedExpense, days: number): number {
  return Math.round((expense.money.amountCents * days) / CADENCE_DAYS[expense.cadence]);
}

interface WindowTotals {
  discretionary: Money;
  recurring: Money;
  total: Money;
}

function windowTotals(
  currency: string,
  transactions: Transaction[],
  expenses: FixedExpense[],
  period: Period,
): WindowTotals {
  const days = periodDays(period);
  const discretionary = sum(
    transactions.map((transaction) => transaction.money),
    currency,
  );
  const recurring = sum(
    activeExpenses(expenses).map((expense) => ({
      amountCents: proratedCents(expense, days),
      currency,
    })),
    currency,
  );
  return { discretionary, recurring, total: add(discretionary, recurring) };
}

function categoryTotals(
  currency: string,
  transactions: Transaction[],
  expenses: FixedExpense[],
  days: number,
  totalCents: number,
): CategoryTotal[] {
  const cents = new Map<string, number>();
  const addTo = (categoryId: string, amount: number): void => {
    cents.set(categoryId, (cents.get(categoryId) ?? 0) + amount);
  };

  for (const transaction of transactions) addTo(transaction.categoryId, transaction.money.amountCents);
  for (const expense of expenses) addTo(expense.categoryId, proratedCents(expense, days));

  return (
    [...cents.entries()]
      // Largest first, id breaking ties — so the order never depends on which
      // page a row arrived on, which is the one thing about the input that can
      // vary between two runs over the same data.
      .sort(([aId, a], [bId, b]) => b - a || aId.localeCompare(bId))
      .map(([categoryId, amountCents]) => ({
        categoryId,
        total: { amountCents, currency },
        // Rounded to four places: a raw ratio carries binary float noise, and
        // two runs over identical data must serialise identically.
        share: totalCents === 0 ? 0 : Math.round((amountCents / totalCents) * 1e4) / 1e4,
      }))
  );
}

/**
 * Compute a user's spend statistics over `period`.
 *
 * Throws `MixedCurrencyError` if the ledger holds an amount outside its own
 * currency — an explicit failure rather than a total that added dollars to
 * euros. An empty ledger is not an error: it reports zeroes denominated in the
 * ledger's currency.
 */
export function aggregate(period: Period, ledger: Ledger): SpendStats {
  const days = periodDays(period);
  const previous = previousPeriod(period);

  // Only the amounts that actually reach a total are guarded. A deactivated
  // commitment in some other currency contributes to nothing, and rejecting on
  // it would take /stats down entirely for a row the caller cannot see and no
  // figure depends on.
  assertSingleCurrency(ledger.currency, [
    ...ledger.transactions.map((transaction) => transaction.money),
    ...ledger.previousTransactions.map((transaction) => transaction.money),
    ...activeExpenses(ledger.fixedExpenses).map((expense) => expense.money),
  ]);

  const current = windowTotals(ledger.currency, ledger.transactions, ledger.fixedExpenses, period);
  const prior = windowTotals(
    ledger.currency,
    ledger.previousTransactions,
    ledger.fixedExpenses,
    previous,
  );

  const byCategory = categoryTotals(
    ledger.currency,
    ledger.transactions,
    activeExpenses(ledger.fixedExpenses),
    days,
    current.total.amountCents,
  );

  // Averaged from the total rather than accumulated per day, so the two averages
  // stay consistent with `total` and with each other.
  const perDay = current.total.amountCents / days;

  return {
    periodStart: period.start,
    periodEnd: period.end,
    currency: ledger.currency,
    total: current.total,
    byCategory,
    topCategories: byCategory.slice(0, TOP_CATEGORY_COUNT),
    recurringTotal: current.recurring,
    discretionaryTotal: current.discretionary,
    dailyAverage: { amountCents: Math.round(perDay), currency: ledger.currency },
    weeklyAverage: { amountCents: Math.round(perDay * 7), currency: ledger.currency },
    momDeltaCents: current.total.amountCents - prior.total.amountCents,
  };
}
