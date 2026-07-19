import { describe, it, expect } from "vitest";
import {
  activeExpenses,
  aggregate,
  periodDays,
  previousPeriod,
  proratedCents,
  type Ledger,
  type Period,
} from "./aggregate";
import { MixedCurrencyError } from "../domain/money";
import type { Cadence, FixedExpense, Transaction } from "../domain/types";

const USER = "user-1";

// Ordered so the tie-break assertion below means something: FOOD sorts before
// TRANSPORT, so two equal category totals must come back in that order.
const FOOD = "11111111-1111-4111-8111-111111111111";
const TRANSPORT = "22222222-2222-4222-8222-222222222222";
const HEALTH = "33333333-3333-4333-8333-333333333333";

let seq = 0;

const tx = (
  amountCents: number,
  categoryId: string,
  occurredAt: string,
  currency = "EUR",
): Transaction => ({
  id: `tx-${++seq}`,
  userId: USER,
  money: { amountCents, currency },
  categoryId,
  occurredAt: `${occurredAt}T12:00:00.000Z`,
  createdAt: `${occurredAt}T12:00:00.000Z`,
});

const fixed = (
  amountCents: number,
  categoryId: string,
  cadence: Cadence,
  opts: { createdAt?: string; active?: boolean; currency?: string } = {},
): FixedExpense => ({
  id: `fx-${++seq}`,
  userId: USER,
  label: `fixed-${seq}`,
  categoryId,
  money: { amountCents, currency: opts.currency ?? "EUR" },
  cadence,
  active: opts.active ?? true,
  createdAt: `${opts.createdAt ?? "2026-01-01"}T00:00:00.000Z`,
});

// A seven-day window, chosen so a weekly fixed expense prorates to exactly its
// own amount and every expected figure below can be worked out by hand.
const PERIOD: Period = { start: "2026-07-06", end: "2026-07-12" };

/**
 * The worked example the assertions are checked against:
 *
 *   discretionary  2500 + 1500 (food) + 4000 (transport)  =  8000
 *   recurring      5000 weekly gym over exactly 7 days    =  5000
 *   total                                                 = 13000
 *   previous       3000 spent + the same 5000 gym         =  8000
 *   delta          13000 - 8000                           =  5000
 */
const ledger = (): Ledger => ({
  currency: "EUR",
  transactions: [
    tx(2500, FOOD, "2026-07-07"),
    tx(1500, FOOD, "2026-07-09"),
    tx(4000, TRANSPORT, "2026-07-11"),
  ],
  previousTransactions: [tx(3000, FOOD, "2026-07-02")],
  fixedExpenses: [fixed(5000, HEALTH, "weekly")],
});

const eur = (amountCents: number) => ({ amountCents, currency: "EUR" });

describe("periodDays", () => {
  it("counts both bounds — a single day is 1", () => {
    expect(periodDays({ start: "2026-07-06", end: "2026-07-06" })).toBe(1);
    expect(periodDays(PERIOD)).toBe(7);
    expect(periodDays({ start: "2026-07-01", end: "2026-07-31" })).toBe(31);
  });

  it("counts across a month and a leap day", () => {
    expect(periodDays({ start: "2026-01-31", end: "2026-02-01" })).toBe(2);
    expect(periodDays({ start: "2028-02-28", end: "2028-03-01" })).toBe(3);
  });

  it("rejects an inverted window", () => {
    expect(() => periodDays({ start: "2026-07-12", end: "2026-07-06" })).toThrow(RangeError);
  });

  it("rejects an unparseable bound", () => {
    expect(() => periodDays({ start: "not-a-date", end: "2026-07-06" })).toThrow(TypeError);
  });
});

describe("previousPeriod", () => {
  it("is the same length, ending the day before the period starts", () => {
    expect(previousPeriod(PERIOD)).toEqual({ start: "2026-06-29", end: "2026-07-05" });
  });

  it("walks back across a month boundary by days, not by calendar month", () => {
    expect(previousPeriod({ start: "2026-07-01", end: "2026-07-31" })).toEqual({
      start: "2026-05-31",
      end: "2026-06-30",
    });
  });

  it("compares month-to-date against a trailing window, not the same dates last month", () => {
    // Pinned because the name `momDeltaCents` invites the other reading: a
    // 19-day July window looks back at 12–30 June, not 1–19 June.
    expect(previousPeriod({ start: "2026-07-01", end: "2026-07-19" })).toEqual({
      start: "2026-06-12",
      end: "2026-06-30",
    });
  });
});

describe("proratedCents", () => {
  it("charges a weekly expense in full over exactly a week", () => {
    expect(proratedCents(fixed(7000, HEALTH, "weekly"), 7)).toBe(7000);
    expect(proratedCents(fixed(7000, HEALTH, "weekly"), 14)).toBe(14000);
  });

  it("converts monthly and yearly cadences through the same daily rate", () => {
    // 304375 / (365.25/12) = 10000 per day; 365250 / 365.25 = 1000 per day.
    expect(proratedCents(fixed(304375, HEALTH, "monthly"), 7)).toBe(70000);
    expect(proratedCents(fixed(365250, HEALTH, "yearly"), 7)).toBe(7000);
  });

  it("rounds to whole cents", () => {
    // 1000 * 3 / 7 = 428.57…
    expect(proratedCents(fixed(1000, HEALTH, "weekly"), 3)).toBe(429);
  });
});

describe("activeExpenses", () => {
  it("excludes an inactive expense", () => {
    expect(activeExpenses([fixed(5000, HEALTH, "weekly", { active: false })])).toEqual([]);
  });

  it("keeps one entered after the window it is being applied to", () => {
    // The regression this guards: `createdAt` is when the row was typed in, not
    // when the commitment began, so filtering on it made every period before
    // onboarding report zero recurring spend.
    const expenses = [fixed(5000, HEALTH, "weekly", { createdAt: "2027-01-01" })];
    expect(activeExpenses(expenses)).toHaveLength(1);
  });
});

describe("aggregate", () => {
  it("computes the worked example's totals", () => {
    const stats = aggregate(PERIOD, ledger());

    expect(stats.periodStart).toBe("2026-07-06");
    expect(stats.periodEnd).toBe("2026-07-12");
    expect(stats.currency).toBe("EUR");
    expect(stats.discretionaryTotal).toEqual(eur(8000));
    expect(stats.recurringTotal).toEqual(eur(5000));
    expect(stats.total).toEqual(eur(13000));
  });

  it("splits per category, largest first with the id breaking ties", () => {
    const stats = aggregate(PERIOD, ledger());

    expect(stats.byCategory).toEqual([
      { categoryId: HEALTH, total: eur(5000), share: 0.3846 },
      // Food and transport are both 4000 — FOOD's id sorts first.
      { categoryId: FOOD, total: eur(4000), share: 0.3077 },
      { categoryId: TRANSPORT, total: eur(4000), share: 0.3077 },
    ]);
  });

  it("keeps the top categories as a prefix of the full breakdown", () => {
    const stats = aggregate(PERIOD, ledger());
    expect(stats.topCategories).toEqual(stats.byCategory.slice(0, 5));
  });

  it("caps topCategories at five even with more categories in play", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      tx(1000 + i, `${i}0000000-0000-4000-8000-000000000000`, "2026-07-07"),
    );
    const stats = aggregate(PERIOD, {
      currency: "EUR",
      transactions: many,
      previousTransactions: [],
      fixedExpenses: [],
    });

    expect(stats.byCategory).toHaveLength(8);
    expect(stats.topCategories).toHaveLength(5);
    // Largest first: the last-generated transaction is the biggest.
    expect(stats.topCategories[0]?.total.amountCents).toBe(1007);
  });

  it("averages from the total over the period's length", () => {
    const stats = aggregate(PERIOD, ledger());
    // 13000 / 7 = 1857.14…
    expect(stats.dailyAverage).toEqual(eur(1857));
    expect(stats.weeklyAverage).toEqual(eur(13000));
  });

  it("reports the delta against the previous comparable window", () => {
    const stats = aggregate(PERIOD, ledger());
    expect(stats.momDeltaCents).toBe(5000);
  });

  it("reports a negative delta when spend fell", () => {
    const stats = aggregate(PERIOD, {
      ...ledger(),
      previousTransactions: [tx(20000, FOOD, "2026-07-02")],
    });
    // 13000 - (20000 + 5000) = -12000
    expect(stats.momDeltaCents).toBe(-12000);
  });

  it("charges a fixed expense to a window that predates the row", () => {
    const stats = aggregate(PERIOD, {
      currency: "EUR",
      transactions: [],
      previousTransactions: [],
      // Entered long after both windows — a user typing in standing rent.
      fixedExpenses: [fixed(5000, HEALTH, "weekly", { createdAt: "2027-01-01" })],
    });

    expect(stats.recurringTotal).toEqual(eur(5000));
    // Charged to both windows at the same rate, so it cancels out of the delta.
    expect(stats.momDeltaCents).toBe(0);
  });

  it("leaves a deactivated commitment out of the picture entirely", () => {
    const stats = aggregate(PERIOD, {
      currency: "EUR",
      transactions: [],
      previousTransactions: [],
      fixedExpenses: [fixed(5000, HEALTH, "weekly", { active: false })],
    });

    expect(stats.recurringTotal).toEqual(eur(0));
    expect(stats.byCategory).toEqual([]);
  });

  it("reports zeroes in the ledger's currency for an empty ledger", () => {
    const stats = aggregate(PERIOD, {
      currency: "EUR",
      transactions: [],
      previousTransactions: [],
      fixedExpenses: [],
    });

    expect(stats).toEqual({
      periodStart: "2026-07-06",
      periodEnd: "2026-07-12",
      currency: "EUR",
      total: eur(0),
      byCategory: [],
      topCategories: [],
      recurringTotal: eur(0),
      discretionaryTotal: eur(0),
      dailyAverage: eur(0),
      weeklyAverage: eur(0),
      momDeltaCents: 0,
    });
  });

  it("gives every category a zero share when nothing was spent", () => {
    // A zero-amount ledger still names its categories; the share must not be NaN.
    const stats = aggregate(PERIOD, {
      currency: "EUR",
      transactions: [tx(0, FOOD, "2026-07-07")],
      previousTransactions: [],
      fixedExpenses: [],
    });

    expect(stats.byCategory).toEqual([{ categoryId: FOOD, total: eur(0), share: 0 }]);
  });

  it("is deterministic — the same ledger yields identical stats", () => {
    const fixture = ledger();
    expect(aggregate(PERIOD, fixture)).toEqual(aggregate(PERIOD, fixture));
  });

  it("does not depend on the order rows arrived in", () => {
    const fixture = ledger();
    const reversed: Ledger = { ...fixture, transactions: [...fixture.transactions].reverse() };
    expect(aggregate(PERIOD, reversed)).toEqual(aggregate(PERIOD, fixture));
  });

  describe("the single-currency guard", () => {
    it("throws on a transaction outside the ledger's currency", () => {
      const fixture = ledger();
      expect(() =>
        aggregate(PERIOD, {
          ...fixture,
          transactions: [...fixture.transactions, tx(1000, FOOD, "2026-07-08", "USD")],
        }),
      ).toThrow(MixedCurrencyError);
    });

    it("throws on a fixed expense outside the ledger's currency", () => {
      expect(() =>
        aggregate(PERIOD, {
          ...ledger(),
          fixedExpenses: [fixed(5000, HEALTH, "weekly", { currency: "USD" })],
        }),
      ).toThrow(MixedCurrencyError);
    });

    it("throws on a previous-window transaction, which the delta would have used", () => {
      expect(() =>
        aggregate(PERIOD, {
          ...ledger(),
          previousTransactions: [tx(3000, FOOD, "2026-07-02", "USD")],
        }),
      ).toThrow(MixedCurrencyError);
    });

    it("ignores a deactivated expense in another currency", () => {
      // It contributes to no total, so rejecting on it would take /stats down
      // over a row the caller cannot see and no reported figure depends on.
      const stats = aggregate(PERIOD, {
        ...ledger(),
        fixedExpenses: [
          fixed(5000, HEALTH, "weekly"),
          fixed(9999, HEALTH, "weekly", { active: false, currency: "USD" }),
        ],
      });

      expect(stats.recurringTotal).toEqual(eur(5000));
    });

    it("throws when the ledger is uniform but disagrees with the profile currency", () => {
      // Self-consistent, so summing succeeds — the total would simply be
      // labelled EUR while holding dollars. This is the case a pairwise check
      // between amounts would miss.
      expect(() =>
        aggregate(PERIOD, {
          currency: "EUR",
          transactions: [tx(2500, FOOD, "2026-07-07", "USD")],
          previousTransactions: [],
          fixedExpenses: [],
        }),
      ).toThrow(MixedCurrencyError);
    });
  });
});
