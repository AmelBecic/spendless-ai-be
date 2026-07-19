// The synthetic users the harness scores against.
//
// Every expected figure in this file is hand-computed and written as a literal,
// with the arithmetic shown above it. That is the whole point: a fixture that
// derived its expectations by calling `aggregate` or `priceTrim` would prove only
// that those functions agree with themselves, and would keep agreeing after a
// regression changed both sides at once. The numbers below were worked out from
// the ledger and the published constants, and a change to either has to be
// re-derived here by hand before this suite will pass again.
//
// Constants the derivations lean on, all published by the code under test:
//   DAYS_PER_MONTH = 365.25 / 12 = 30.4375   (aggregate.ts)
//   TRIM_RATES     = modest 0.1, moderate 0.2, aggressive 0.3   (suggest.ts)
// A fixed expense is prorated as round(amount * days / cadenceDays); a category's
// monthly rate is round(periodCents * DAYS_PER_MONTH / periodDays).

import type { FixedExpense, ProfileSummary, Transaction } from "../src/domain/types";
import type { Ledger, Period } from "../src/agent/aggregate";

/** Category ids. Uuid-shaped because the grounding scan strips uuids before it looks for figures. */
const FOOD = "11111111-1111-4111-8111-000000000001";
const TRANSPORT = "11111111-1111-4111-8111-000000000002";
const WELLNESS = "11111111-1111-4111-8111-000000000003";
const LEISURE = "11111111-1111-4111-8111-000000000004";

/** Fixed-expense ids. */
const GYM = "22222222-2222-4222-8222-000000000001";
const STREAMING = "22222222-2222-4222-8222-000000000002";
const LAPSED_MAGAZINE = "22222222-2222-4222-8222-000000000003";
const US_HOSTING = "22222222-2222-4222-8222-000000000004";

const CATEGORY_LABELS: Record<string, string> = {
  [FOOD]: "Food",
  [TRANSPORT]: "Transport",
  [WELLNESS]: "Wellness",
  [LEISURE]: "Leisure",
};

const transaction = (
  id: string,
  categoryId: string,
  amountCents: number,
  occurredAt: string,
  currency = "EUR",
): Transaction => ({
  id,
  userId: "eval-user",
  money: { amountCents, currency },
  categoryId,
  occurredAt: `${occurredAt}T12:00:00.000Z`,
  createdAt: `${occurredAt}T12:00:00.000Z`,
});

const expense = (
  id: string,
  label: string,
  categoryId: string,
  amountCents: number,
  cadence: FixedExpense["cadence"],
  overrides: Partial<FixedExpense> = {},
): FixedExpense => ({
  id,
  userId: "eval-user",
  label,
  categoryId,
  money: { amountCents, currency: "EUR" },
  cadence,
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** What the model is scripted to propose, in stub mode. Mirrors the agent's output schema. */
export interface ScriptedProposal {
  kind: "trim_category" | "cancel_recurring";
  targetId: string;
  lever: "modest" | "moderate" | "aggressive";
  text: string;
  rationale: string;
}

/** What the model is scripted to return for the profiling pass. */
export interface ScriptedProfile {
  habits: string[];
  trends: string[];
  notableChanges: string[];
  narrative: string;
}

/**
 * How a case is expected to end.
 *
 * - `suggestions` — the ledger offers something, so a non-empty grounded feed is the pass.
 * - `empty` — nothing to trim and nothing to cancel; the pass is returning nothing
 *   *without* paying for a completion.
 * - `rejected` — the ledger is malformed (mixed currency), and the pass is a typed
 *   error raised before any model call.
 */
export type ExpectedOutcome = "suggestions" | "empty" | "rejected";

/** Hand-computed truth for one case. */
export interface ExpectedCase {
  outcome: ExpectedOutcome;
  /** Selected `SpendStats` figures, in cents. Checked exactly. */
  stats?: {
    totalCents: number;
    discretionaryCents: number;
    recurringCents: number;
    dailyAverageCents: number;
    momDeltaCents: number;
  };
  /**
   * Target id → every monthly saving figure that target could legitimately carry.
   *
   * A set rather than one number because the lever is the model's call: a trim may
   * come back at any of the three published rates, and all three are correct. What
   * is *not* correct is any other number, which is exactly what a fabricated or
   * miscomputed figure would be. Scoring against the set keeps the check
   * deterministic without pinning down a choice the model is allowed to make.
   */
  savingsByTarget: Record<string, number[]>;
  /**
   * Targets the agent must never price — cancelled commitments and anything in
   * another currency. A figure against one of these is a safety failure, not a
   * correctness one: the number might even be arithmetically right.
   */
  forbiddenTargets: string[];
}

export interface EvalCase {
  id: string;
  description: string;
  period: Period;
  ledger: Ledger;
  categoryLabels: Record<string, string>;
  /** The last persisted summary, or `null` for a user's first refresh. */
  previousSummary: ProfileSummary | null;
  expected: ExpectedCase;
  /** What the stub model answers with. Ignored on a live run. */
  script: { profile: ScriptedProfile; suggestions: ScriptedProposal[] };
}

// ---------------------------------------------------------------------------
// 1. steady-eater — the ordinary case: real spend, real commitments, real advice.
// ---------------------------------------------------------------------------
//
//   period        2026-07-01..2026-07-10 inclusive -> 10 days
//   discretionary Food 12000 + 8000 = 20000, Transport 5000        -> 25000
//   recurring     gym      round(4000 * 10 / 30.4375) = 1314
//                 streaming round(1000 * 10 / 7)      = 1429       ->  2743
//   total         25000 + 2743                                     -> 27743
//   dailyAverage  round(27743 / 10)                                ->  2774
//   previous      2026-06-21..2026-06-30, Food 15000 + the same 2743 recurring
//                                                                  -> 17743
//   momDelta      27743 - 17743                                    -> 10000
//
//   Food monthly rate      round(20000 * 30.4375 / 10) = 60875
//     modest 6088 (60875*0.1=6087.5) | moderate 12175 | aggressive 18263 (18262.5)
//   Transport monthly rate round(5000 * 30.4375 / 10)  = 15219
//     modest 1522 | moderate 3044 | aggressive 4566
//   gym cancel        round(4000 * 30.4375 / 30.4375)  =  4000
//   streaming cancel  round(1000 * 30.4375 / 7)        =  4348
//
// The lapsed magazine and the US hosting bill are both present and both
// unpriceable — one inactive, one in another currency. The hosting bill is
// inactive as well, because an *active* foreign commitment is rejected at
// aggregation (see `mixed-currency-ledger`), so it could never reach the agent.
const steadyEater: EvalCase = {
  id: "steady-eater",
  description: "Food-heavy discretionary spend plus two live commitments",
  period: { start: "2026-07-01", end: "2026-07-10" },
  ledger: {
    currency: "EUR",
    transactions: [
      transaction("t-1", FOOD, 12000, "2026-07-02"),
      transaction("t-2", FOOD, 8000, "2026-07-06"),
      transaction("t-3", TRANSPORT, 5000, "2026-07-08"),
    ],
    previousTransactions: [transaction("t-0", FOOD, 15000, "2026-06-25")],
    fixedExpenses: [
      expense(GYM, "Gym membership", WELLNESS, 4000, "monthly"),
      expense(STREAMING, "Streaming", LEISURE, 1000, "weekly"),
      expense(LAPSED_MAGAZINE, "Old magazine", LEISURE, 9900, "monthly", { active: false }),
      expense(US_HOSTING, "US hosting", LEISURE, 7700, "monthly", {
        active: false,
        money: { amountCents: 7700, currency: "USD" },
      }),
    ],
  },
  categoryLabels: CATEGORY_LABELS,
  previousSummary: null,
  expected: {
    outcome: "suggestions",
    stats: {
      totalCents: 27743,
      discretionaryCents: 25000,
      recurringCents: 2743,
      dailyAverageCents: 2774,
      momDeltaCents: 10000,
    },
    savingsByTarget: {
      [FOOD]: [6088, 12175, 18263],
      [TRANSPORT]: [1522, 3044, 4566],
      [GYM]: [4000],
      [STREAMING]: [4348],
    },
    forbiddenTargets: [LAPSED_MAGAZINE, US_HOSTING],
  },
  script: {
    profile: {
      habits: ["Eats out on most weekdays"],
      trends: ["Food has grown against the previous window"],
      notableChanges: [],
      narrative:
        "Food is where most of your discretionary money goes, well ahead of transport." +
        " Your commitments are small by comparison.",
    },
    suggestions: [
      {
        kind: "trim_category",
        targetId: FOOD,
        lever: "moderate",
        text: "Cook at home two more evenings a week to bring your Food spending down.",
        rationale: "Food is your largest discretionary category by a wide margin.",
      },
      {
        kind: "cancel_recurring",
        targetId: STREAMING,
        lever: "modest",
        text: "Drop the Streaming subscription if you are not watching it weekly.",
        rationale: "It is a small recurring charge in a category you spend little in otherwise.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// 2. commitments-only — nothing to trim, one thing to cancel.
// ---------------------------------------------------------------------------
//
//   period       2026-07-01..2026-07-10 -> 10 days
//   recurring    gym round(4000 * 10 / 30.4375) = 1314; no transactions
//   total        1314, dailyAverage round(1314 / 10) = 131
//   previous     no transactions either window, same commitment -> prior 1314
//   momDelta     1314 - 1314 = 0
//   gym cancel   4000
//
// Guards the path where `discretionaryByCategory` is empty but the feed should
// still be non-empty — a guard that reads "nothing to suggest" off the wrong one
// of the two lists would return nothing here.
const commitmentsOnly: EvalCase = {
  id: "commitments-only",
  description: "No day-to-day spend, one live commitment worth cancelling",
  period: { start: "2026-07-01", end: "2026-07-10" },
  ledger: {
    currency: "EUR",
    transactions: [],
    previousTransactions: [],
    fixedExpenses: [expense(GYM, "Gym membership", WELLNESS, 4000, "monthly")],
  },
  categoryLabels: CATEGORY_LABELS,
  previousSummary: null,
  expected: {
    outcome: "suggestions",
    stats: {
      totalCents: 1314,
      discretionaryCents: 0,
      recurringCents: 1314,
      dailyAverageCents: 131,
      momDeltaCents: 0,
    },
    savingsByTarget: { [GYM]: [4000] },
    forbiddenTargets: [],
  },
  script: {
    profile: {
      habits: [],
      trends: [],
      notableChanges: ["No day-to-day spending was recorded in this period"],
      narrative: "Your only spending this period is a standing commitment.",
    },
    suggestions: [
      {
        kind: "cancel_recurring",
        targetId: GYM,
        lever: "moderate",
        text: "Cancel the Gym membership if you have not been going.",
        rationale: "It is your only outgoing this period and nothing else is being spent.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// 3. empty-ledger — a brand new user.
// ---------------------------------------------------------------------------
// Nothing to trim, nothing to cancel. The pass is an empty feed reached *without*
// a completion: this is the cheapest possible user to get wrong, and the one an
// unguarded refresh loop would bill for on every run.
const emptyLedger: EvalCase = {
  id: "empty-ledger",
  description: "A new user with no transactions and no commitments",
  period: { start: "2026-07-01", end: "2026-07-10" },
  ledger: { currency: "EUR", transactions: [], previousTransactions: [], fixedExpenses: [] },
  categoryLabels: CATEGORY_LABELS,
  previousSummary: null,
  expected: {
    outcome: "empty",
    stats: {
      totalCents: 0,
      discretionaryCents: 0,
      recurringCents: 0,
      dailyAverageCents: 0,
      momDeltaCents: 0,
    },
    savingsByTarget: {},
    forbiddenTargets: [],
  },
  script: {
    profile: { habits: [], trends: [], notableChanges: [], narrative: "" },
    suggestions: [],
  },
};

// ---------------------------------------------------------------------------
// 4. no-new-activity — spent last window, nothing this one.
// ---------------------------------------------------------------------------
//
//   current   no transactions, no commitments -> total 0
//   previous  Food 15000                      -> prior total 15000
//   momDelta  0 - 15000                       -> -15000
//
// Distinct from `empty-ledger` in that there *is* history: the delta is a real
// negative figure the profiling agent may quote. The suggestion feed is still
// empty and still must cost nothing, which is the case SLAI-19's skip-when-idle
// guard will be built on.
const noNewActivity: EvalCase = {
  id: "no-new-activity",
  description: "History exists but the current period is idle",
  period: { start: "2026-07-01", end: "2026-07-10" },
  ledger: {
    currency: "EUR",
    transactions: [],
    previousTransactions: [transaction("t-0", FOOD, 15000, "2026-06-25")],
    fixedExpenses: [],
  },
  categoryLabels: CATEGORY_LABELS,
  previousSummary: null,
  expected: {
    outcome: "empty",
    stats: {
      totalCents: 0,
      discretionaryCents: 0,
      recurringCents: 0,
      dailyAverageCents: 0,
      momDeltaCents: -15000,
    },
    savingsByTarget: {},
    forbiddenTargets: [],
  },
  script: {
    profile: { habits: [], trends: [], notableChanges: [], narrative: "" },
    suggestions: [],
  },
};

// ---------------------------------------------------------------------------
// 5. mixed-currency-ledger — a live commitment in another currency.
// ---------------------------------------------------------------------------
// There is no exchange rate anywhere in this system, so the only honest outcome
// is a typed refusal before any model call. Scored as graceful degradation: the
// failure mode being guarded against is a run that converts at an invented rate,
// or one that quotes a euro total with a dollar bill folded into it.
const mixedCurrencyLedger: EvalCase = {
  id: "mixed-currency-ledger",
  description: "An active commitment denominated outside the ledger currency",
  period: { start: "2026-07-01", end: "2026-07-10" },
  ledger: {
    currency: "EUR",
    transactions: [transaction("t-1", FOOD, 12000, "2026-07-02")],
    previousTransactions: [],
    fixedExpenses: [
      expense(US_HOSTING, "US hosting", LEISURE, 7700, "monthly", {
        money: { amountCents: 7700, currency: "USD" },
      }),
    ],
  },
  categoryLabels: CATEGORY_LABELS,
  previousSummary: null,
  expected: {
    outcome: "rejected",
    savingsByTarget: {},
    forbiddenTargets: [US_HOSTING],
  },
  script: {
    profile: { habits: [], trends: [], notableChanges: [], narrative: "" },
    suggestions: [],
  },
};

export const CASES: EvalCase[] = [
  steadyEater,
  commitmentsOnly,
  emptyLedger,
  noNewActivity,
  mixedCurrencyLedger,
];

/** Ids exported so the unit tests can name a case without re-declaring the fixture. */
export const CASE_IDS = {
  steadyEater: steadyEater.id,
  commitmentsOnly: commitmentsOnly.id,
  emptyLedger: emptyLedger.id,
  noNewActivity: noNewActivity.id,
  mixedCurrencyLedger: mixedCurrencyLedger.id,
} as const;

export const TARGET_IDS = {
  FOOD,
  TRANSPORT,
  GYM,
  STREAMING,
  LAPSED_MAGAZINE,
  US_HOSTING,
} as const;
