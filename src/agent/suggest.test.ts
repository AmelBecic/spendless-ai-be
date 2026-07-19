import { describe, it, expect } from "vitest";
import type { CategoryTotal, FixedExpense, ProfileSummary, SpendStats } from "../domain/types";
import type { LlmClient, LlmRequest } from "../agent/anthropic";
import { MODEL } from "../agent/anthropic";
import {
  buildSuggestionInput,
  knownSourceRefs,
  runSuggestionAgent,
  SUGGEST_SYSTEM_PROMPT,
  TRIM_RATES,
  type SuggestionAgentInput,
} from "./suggest";

// The figures below are hand-computed against this fixture, deliberately rather
// than by calling the helpers the code under test uses — a test that recomputes
// the answer the same way proves only that the function is consistent with
// itself, which is exactly the property that would survive the bug this ticket
// exists to prevent.
//
//   period      2026-07-01..2026-07-10, inclusive -> 10 days
//   month       365.25 / 12 = 30.4375 days
//   food        20000 cents of *discretionary* spend over 10 days — a trim is
//               priced against transactions only, never against a category
//               total that has prorated commitments folded into it
//                 -> monthly rate round(20000 * 30.4375 / 10) = 60875
//                 -> moderate (0.2)  round(60875 * 0.2) = 12175
//                 -> modest   (0.1)  round(60875 * 0.1) = 6088  (60875*0.1=6087.5)
//   gym         4000 cents monthly    -> 4000 exactly
//   streaming   1000 cents weekly     -> round(1000 * 30.4375 / 7) = 4348

const FOOD = "11111111-1111-4111-8111-111111111111";
const TRANSPORT = "22222222-2222-4222-8222-222222222222";
const MISSING_CATEGORY = "99999999-9999-4999-8999-999999999999";

const GYM = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const STREAMING = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CANCELLED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000004";

const FOOD_MODERATE_CENTS = 12175;
const FOOD_MODEST_CENTS = 6088;
const GYM_CENTS = 4000;
const STREAMING_CENTS = 4348;

const stats: SpendStats = {
  periodStart: "2026-07-01",
  periodEnd: "2026-07-10",
  currency: "EUR",
  total: { amountCents: 25000, currency: "EUR" },
  byCategory: [
    { categoryId: FOOD, total: { amountCents: 20000, currency: "EUR" }, share: 0.8 },
    { categoryId: TRANSPORT, total: { amountCents: 5000, currency: "EUR" }, share: 0.2 },
  ],
  topCategories: [
    { categoryId: FOOD, total: { amountCents: 20000, currency: "EUR" }, share: 0.8 },
    { categoryId: TRANSPORT, total: { amountCents: 5000, currency: "EUR" }, share: 0.2 },
  ],
  recurringTotal: { amountCents: 5000, currency: "EUR" },
  discretionaryTotal: { amountCents: 20000, currency: "EUR" },
  dailyAverage: { amountCents: 2500, currency: "EUR" },
  weeklyAverage: { amountCents: 17500, currency: "EUR" },
  momDeltaCents: 1000,
};

// Transactions only: the gym's prorated share sits in `stats.byCategory` but is
// deliberately absent here, since cutting a gym contract is not something a food
// budget can be trimmed into.
const discretionary: CategoryTotal[] = [
  { categoryId: FOOD, total: { amountCents: 20000, currency: "EUR" }, share: 1 },
];

const expense = (
  id: string,
  label: string,
  amountCents: number,
  cadence: FixedExpense["cadence"],
  overrides: Partial<FixedExpense> = {},
): FixedExpense => ({
  id,
  userId: "user-1",
  label,
  categoryId: TRANSPORT,
  money: { amountCents, currency: "EUR" },
  cadence,
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const fixedExpenses: FixedExpense[] = [
  expense(GYM, "Gym", 4000, "monthly"),
  expense(STREAMING, "Streaming", 1000, "weekly"),
  expense(CANCELLED, "Old magazine", 9900, "monthly", { active: false }),
  expense(FOREIGN, "US hosting", 7700, "monthly", {
    money: { amountCents: 7700, currency: "USD" },
  }),
];

const profile: ProfileSummary = {
  id: "cccccccc-cccc-4ccc-8ccc-000000000001",
  userId: "user-1",
  asOfDate: "2026-07-10",
  summary: { habits: ["Eats out on weekdays"], trends: [], notableChanges: [] },
  narrative: "Food is the largest share of your spending.",
  model: MODEL,
  createdAt: "2026-07-10T00:00:00.000Z",
};

const input: SuggestionAgentInput = {
  profile,
  stats,
  discretionaryByCategory: discretionary,
  fixedExpenses,
  categoryLabels: { [FOOD]: "Food", [TRANSPORT]: "Transport" },
};

interface Proposal {
  kind: "trim_category" | "cancel_recurring";
  targetId: string;
  lever: "modest" | "moderate" | "aggressive";
  text: string;
  rationale: string;
}

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  kind: "trim_category",
  targetId: FOOD,
  lever: "moderate",
  text: "Cook at home two more evenings a week.",
  rationale: "Food is your largest discretionary category by a wide margin.",
  ...overrides,
});

/** An LLM that returns exactly these proposals, and records what it was sent. */
function llmReturning(suggestions: unknown[], seen: LlmRequest<unknown>[] = []): LlmClient {
  return {
    complete: <T>(request: LlmRequest<T>) => {
      seen.push(request as LlmRequest<unknown>);
      return Promise.resolve({
        data: { suggestions } as unknown as T,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          estimatedCostUsd: 0,
        },
      });
    },
  };
}

const run = (suggestions: unknown[], over: Partial<SuggestionAgentInput> = {}) =>
  runSuggestionAgent(llmReturning(suggestions), { ...input, ...over });

describe("runSuggestionAgent — figures are computed, not modelled", () => {
  it("prices a category trim from the category's monthly rate", async () => {
    const result = await run([proposal()]);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.estMonthlySavings).toEqual({
      amountCents: FOOD_MODERATE_CENTS,
      currency: "EUR",
    });
  });

  it("scales the figure by the lever, using rates the model cannot set", async () => {
    const modest = await run([proposal({ lever: "modest" })]);
    const moderate = await run([proposal({ lever: "moderate" })]);
    const aggressive = await run([proposal({ lever: "aggressive" })]);

    expect(modest.suggestions[0]?.estMonthlySavings.amountCents).toBe(FOOD_MODEST_CENTS);
    expect(moderate.suggestions[0]?.estMonthlySavings.amountCents).toBe(FOOD_MODERATE_CENTS);
    // The ordering is the contract the lever names; the rates are code constants.
    expect(aggressive.suggestions[0]?.estMonthlySavings.amountCents).toBeGreaterThan(
      FOOD_MODERATE_CENTS,
    );
    expect(TRIM_RATES.modest).toBeLessThan(TRIM_RATES.aggressive);
  });

  it("prices a cancellation as the commitment's monthly equivalent", async () => {
    const monthly = await run([proposal({ kind: "cancel_recurring", targetId: GYM })]);
    const weekly = await run([proposal({ kind: "cancel_recurring", targetId: STREAMING })]);

    // A monthly commitment is worth exactly its own amount per month...
    expect(monthly.suggestions[0]?.estMonthlySavings.amountCents).toBe(GYM_CENTS);
    // ...a weekly one is normalised onto the average month.
    expect(weekly.suggestions[0]?.estMonthlySavings.amountCents).toBe(STREAMING_CENTS);
  });

  it("ignores an amount the model volunteers instead of trusting it", async () => {
    // The schema gives the model no such field, so this can only arrive from a
    // model going off-contract. It must not reach the user under any path.
    const result = await run([{ ...proposal(), estMonthlySavingsCents: 999999, currency: "USD" }]);

    expect(result.suggestions[0]?.estMonthlySavings).toEqual({
      amountCents: FOOD_MODERATE_CENTS,
      currency: "EUR",
    });
  });

  it("denominates every saving in the stats currency", async () => {
    const result = await run([proposal(), proposal({ kind: "cancel_recurring", targetId: GYM })]);

    for (const suggestion of result.suggestions) {
      expect(suggestion.estMonthlySavings.currency).toBe(stats.currency);
      expect(Number.isInteger(suggestion.estMonthlySavings.amountCents)).toBe(true);
    }
  });
});

describe("runSuggestionAgent — grounding", () => {
  it("cites only refs that exist for this input", async () => {
    const known = knownSourceRefs(stats, discretionary, fixedExpenses);
    const result = await run([proposal(), proposal({ kind: "cancel_recurring", targetId: GYM })]);

    expect(result.suggestions).toHaveLength(2);
    for (const suggestion of result.suggestions) {
      expect(suggestion.sourceRefs.length).toBeGreaterThan(0);
      for (const ref of suggestion.sourceRefs) expect(known).toContain(ref);
    }
  });

  it("drops a suggestion citing a category the user has no spend in", async () => {
    const result = await run([proposal({ targetId: MISSING_CATEGORY })]);

    expect(result.suggestions).toHaveLength(0);
    expect(result.dropped).toEqual([
      { kind: "trim_category", targetId: MISSING_CATEGORY, reason: "unknown-target" },
    ]);
  });

  it("drops a cancellation of a commitment that was never offered", async () => {
    // Inactive and foreign-currency expenses are withheld from the prompt, so
    // citing one is as ungrounded as citing an id that does not exist.
    const inactive = await run([proposal({ kind: "cancel_recurring", targetId: CANCELLED })]);
    const foreign = await run([proposal({ kind: "cancel_recurring", targetId: FOREIGN })]);

    expect(inactive.suggestions).toHaveLength(0);
    expect(foreign.suggestions).toHaveLength(0);
    // Both exist as rows, so neither is reported as simply unknown.
    expect(foreign.dropped[0]?.reason).toBe("currency-mismatch");
  });

  it("drops a suggestion whose prose states a figure it was not given", async () => {
    const result = await run([
      proposal({ rationale: "You could put 137 euros a month back in your pocket." }),
    ]);

    expect(result.suggestions).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe("ungrounded-figure");
  });

  it("keeps prose that quotes a figure the stats actually contain", async () => {
    const result = await run([
      proposal({ rationale: "Food accounts for 200.00 EUR of this period's spend." }),
    ]);

    expect(result.suggestions).toHaveLength(1);
  });

  it("drops a second suggestion against the same target", async () => {
    const result = await run([proposal(), proposal({ lever: "aggressive" })]);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.estMonthlySavings.amountCents).toBe(FOOD_MODERATE_CENTS);
    expect(result.dropped[0]?.reason).toBe("duplicate-target");
  });

  it("drops a trim worth nothing rather than showing a zero saving", async () => {
    const result = await run([proposal()], {
      discretionaryByCategory: [
        { categoryId: FOOD, total: { amountCents: 0, currency: "EUR" }, share: 0 },
      ],
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe("no-saving");
  });

  it("drops a saving too large for the cents column to hold", async () => {
    // A monthly rate is scaled up from the period observed so far, so a large
    // enough ledger overflows int4. That must not reach the insert as a 500.
    const result = await run([proposal()], {
      discretionaryByCategory: [
        {
          categoryId: FOOD,
          // Reachable: a single transaction may be up to INT4_MAX, and a period
          // holds up to MAX_LEDGER_TRANSACTIONS of them.
          //   round(4e9 * 30.4375 / 10) * 0.2 = 2_435_000_000 > INT4_MAX
          total: { amountCents: 4_000_000_000, currency: "EUR" },
          share: 1,
        },
      ],
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe("not-representable");
  });

  it("keeps the good suggestions when one of a batch is ungrounded", async () => {
    // The whole reason this agent drops rather than throws: one bad item must
    // not cost the user the advice that was fine.
    const result = await run([
      proposal({ targetId: MISSING_CATEGORY }),
      proposal({ kind: "cancel_recurring", targetId: GYM }),
    ]);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.kind).toBe("cancel_recurring");
    expect(result.dropped).toHaveLength(1);
  });
});

describe("the suggestion prompt", () => {
  it("keeps user data out of the cacheable prefix", () => {
    expect(SUGGEST_SYSTEM_PROMPT).not.toContain(FOOD);
    expect(SUGGEST_SYSTEM_PROMPT).not.toContain("2026");
    expect(SUGGEST_SYSTEM_PROMPT).not.toContain("EUR");
  });

  it("offers only spending a trim could actually reach", () => {
    const payload = buildSuggestionInput(input);

    // Food's discretionary total, not the 250.00 period total that has the
    // gym's prorated share folded into it.
    expect(payload).toContain("200.00 EUR");
    expect(payload).toContain("discretionary spend");
  });

  it("shows the model the ids it is required to cite back", () => {
    const payload = buildSuggestionInput(input);

    expect(payload).toContain(FOOD);
    expect(payload).toContain("Food");
    expect(payload).toContain(GYM);
    expect(payload).toContain("Gym");
  });

  it("withholds commitments a saving could not honestly be priced against", () => {
    const payload = buildSuggestionInput(input);

    // Inactive: the user already stopped paying it.
    expect(payload).not.toContain(CANCELLED);
    // Foreign currency: there is no conversion rate in this system to price it.
    expect(payload).not.toContain(FOREIGN);
  });

  it("sends the volatile payload separately from the stable prefix", async () => {
    const seen: LlmRequest<unknown>[] = [];
    await runSuggestionAgent(llmReturning([proposal()], seen), input);

    expect(seen[0]?.system).toBe(SUGGEST_SYSTEM_PROMPT);
    expect(seen[0]?.input).toContain("2026-07-01");
  });
});
