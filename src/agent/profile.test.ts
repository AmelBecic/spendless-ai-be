// The profiling agent, exercised offline against a stubbed model.
//
// The load-bearing test here is the grounding one: the app's whole claim is that
// a figure shown to a user was computed from their ledger, so a model that
// writes a number the stats do not contain must not be able to have it persisted.

import { describe, expect, it } from "vitest";
import type { ProfileSummary, SpendStats, Transaction } from "../domain/types";
import { AppError } from "../http/errors";
import type { LlmClient, LlmRequest, LlmUsage } from "./anthropic";
import { nth } from "../test/stubs";
import {
  PROFILE_SYSTEM_PROMPT,
  allowedFigures,
  buildProfileInput,
  findUngroundedFigures,
  runProfileAgent,
} from "./profile";

const FOOD = "11111111-1111-4111-8111-111111111111";
const HEALTH = "33333333-3333-4333-8333-333333333333";

const eur = (amountCents: number) => ({ amountCents, currency: "EUR" });

const LABELS: Record<string, string> = { [FOOD]: "Food", [HEALTH]: "Health" };

/** Figures chosen so every derived form is exact — no rounding ambiguity. */
const stats: SpendStats = {
  periodStart: "2026-07-01",
  periodEnd: "2026-07-19",
  currency: "EUR",
  total: eur(123456),
  byCategory: [
    { categoryId: FOOD, total: eur(80246), share: 0.65 },
    { categoryId: HEALTH, total: eur(43210), share: 0.35 },
  ],
  topCategories: [{ categoryId: FOOD, total: eur(80246), share: 0.65 }],
  recurringTotal: eur(30000),
  discretionaryTotal: eur(93456),
  dailyAverage: eur(6497),
  weeklyAverage: eur(45478),
  momDeltaCents: 15000,
};

const tx = (amountCents: number, occurredAt: string): Transaction => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-${occurredAt.replace(/-/g, "").padEnd(12, "0")}`,
  userId: "user-1",
  money: eur(amountCents),
  categoryId: FOOD,
  merchant: "Cafe",
  occurredAt: `${occurredAt}T12:00:00.000Z`,
  createdAt: `${occurredAt}T12:00:00.000Z`,
});

const previous: ProfileSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  userId: "user-1",
  asOfDate: "2026-07-12",
  summary: {
    habits: ["Buys lunch out on weekdays"],
    trends: ["Grocery spend easing"],
    notableChanges: ["Started a gym membership"],
  },
  narrative: "Spending held steady through early July.",
  model: "claude-opus-4-8",
  createdAt: "2026-07-12T00:00:00.000Z",
};

const USAGE: LlmUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  estimatedCostUsd: 0.001,
};

interface AgentOutput {
  habits: string[];
  trends: string[];
  notableChanges: string[];
  narrative: string;
}

/**
 * A model that returns exactly what the test dictates, recording the request it
 * was given. The cast is confined to this stub: `complete` is generic over the
 * caller's schema, and a stub cannot prove to the compiler that its canned
 * output matches — the agent's own schema is what enforces that in production.
 */
function stubLlm(output: Partial<AgentOutput>): {
  llm: LlmClient;
  requests: LlmRequest<unknown>[];
} {
  const requests: LlmRequest<unknown>[] = [];
  const data: AgentOutput = {
    habits: output.habits ?? [],
    trends: output.trends ?? [],
    notableChanges: output.notableChanges ?? [],
    narrative: output.narrative ?? "Nothing notable.",
  };
  return {
    requests,
    llm: {
      complete: <T>(request: LlmRequest<T>) => {
        requests.push(request as LlmRequest<unknown>);
        return Promise.resolve({ data: data as unknown as T, usage: USAGE });
      },
    },
  };
}

describe("buildProfileInput", () => {
  it("shows the model only the new transactions, never the full history", () => {
    const input = buildProfileInput({
      previous,
      newTransactions: [tx(1500, "2026-07-15")],
      stats,
      categoryLabels: LABELS,
    });

    expect(input).toContain("2026-07-15");
    // A transaction from before the previous summary is the thing that must not
    // be here — its absence is what makes the loop incremental.
    expect(input).not.toContain("2026-07-03");
  });

  it("carries the previous summary forward so habits can survive a refresh", () => {
    const input = buildProfileInput({
      previous,
      newTransactions: [],
      stats,
      categoryLabels: LABELS,
    });

    expect(input).toContain("Buys lunch out on weekdays");
    expect(input).toContain("As of: 2026-07-12");
    expect(input).toContain("no new transactions since the previous summary");
  });

  it("says so explicitly on a first refresh rather than showing an empty block", () => {
    const input = buildProfileInput({
      previous: null,
      newTransactions: [],
      stats,
      categoryLabels: LABELS,
    });

    expect(input).toContain("first summary for this user");
  });

  it("names categories rather than showing the model raw uuids", () => {
    const input = buildProfileInput({
      previous: null,
      newTransactions: [tx(1500, "2026-07-15")],
      stats,
      categoryLabels: LABELS,
    });

    expect(input).toContain("Food");
    expect(input).toContain("category=Food");
    expect(input).not.toContain(FOOD);
  });

  it("falls back to the id when a category has no label yet", () => {
    const input = buildProfileInput({
      previous: null,
      newTransactions: [],
      stats,
      categoryLabels: {},
    });

    // Unreadable, but the category's spend still appears — dropping the line
    // would understate the period.
    expect(input).toContain(FOOD);
  });

  it("renders amounts in major units, as the model is expected to quote them", () => {
    const input = buildProfileInput({
      previous: null,
      newTransactions: [],
      stats,
      categoryLabels: LABELS,
    });

    expect(input).toContain("1234.56 EUR");
    expect(input).not.toContain("123456 EUR");
  });
});

describe("findUngroundedFigures", () => {
  // Three new transactions, so the permitted counts and the per-transaction
  // amounts both have something real behind them.
  const newTransactions = [tx(1500, "2026-07-15"), tx(2500, "2026-07-16"), tx(3500, "2026-07-17")];
  const allowed = allowedFigures(stats, newTransactions);

  it("accepts a figure quoted straight from the stats", () => {
    expect(findUngroundedFigures("You spent 1234.56 EUR.", allowed)).toEqual([]);
  });

  it("accepts thousands separators and a rounded major unit", () => {
    expect(findUngroundedFigures("You spent about 1,235 EUR.", allowed)).toEqual([]);
  });

  it("accepts a category share written as a percentage", () => {
    expect(findUngroundedFigures("Food was 65% of your spend.", allowed)).toEqual([]);
  });

  it("accepts the period bounds as dates without licensing their parts", () => {
    expect(findUngroundedFigures("Between 2026-07-01 and 2026-07-19.", allowed)).toEqual([]);
    // `07` came only from a date, so a bare 7 elsewhere is still a fabrication.
    expect(findUngroundedFigures("You made 7 large purchases.", allowed)).toEqual(["7"]);
  });

  it("rejects a total the stats do not contain", () => {
    expect(findUngroundedFigures("You spent 999.99 EUR.", allowed)).toEqual(["999.99"]);
  });

  it("rejects a figure derived by the model rather than read from the stats", () => {
    // 1234.56 - 300.00 is a true subtraction, and still not a figure it was given.
    expect(findUngroundedFigures("That leaves 934.55 EUR discretionary.", allowed)).toEqual([
      "934.55",
    ]);
  });

  it("accepts an amount from a transaction the model was shown", () => {
    // The transaction block hands the model these figures; quoting one back is a
    // reading of the ledger, not a fabrication.
    expect(findUngroundedFigures("A 15.00 EUR lunch stood out.", allowed)).toEqual([]);
    expect(findUngroundedFigures("Another was 35.00 EUR.", allowed)).toEqual([]);
  });

  it("still rejects a bare day-of-month ordinal", () => {
    // "the 17th" is not a figure the stats contain, and nothing distinguishes it
    // from a fabricated amount — hence the prompt's rule to spell ordinals out.
    expect(findUngroundedFigures("You spent 35.00 EUR on the 17th.", allowed)).toEqual(["17"]);
  });

  it("ignores a uuid rather than reading it as a run of huge figures", () => {
    expect(findUngroundedFigures(`Category ${FOOD} led your spend.`, allowed)).toEqual([]);
  });

  it("permits a count that matches the data it describes", () => {
    // Two categories, three new transactions — both are claims the stats support.
    expect(findUngroundedFigures("Across 2 categories and 3 purchases.", allowed)).toEqual([]);
  });
});

describe("runProfileAgent", () => {
  it("returns the structured summary and narrative when every figure is grounded", async () => {
    const { llm } = stubLlm({
      habits: ["Spends 1234.56 EUR a month"],
      trends: ["Food holding at 65%"],
      notableChanges: ["Recurring costs steady at 300.00 EUR"],
      narrative: "You spent 1234.56 EUR between 2026-07-01 and 2026-07-19.",
    });

    const result = await runProfileAgent(llm, {
      previous,
      newTransactions: [],
      stats,
      categoryLabels: LABELS,
    });

    expect(result.summary.habits).toEqual(["Spends 1234.56 EUR a month"]);
    expect(result.narrative).toContain("1234.56");
    expect(result.usage.estimatedCostUsd).toBe(USAGE.estimatedCostUsd);
  });

  it("rejects a narrative carrying a figure absent from the stats", async () => {
    const { llm } = stubLlm({ narrative: "You spent 4200.00 EUR, up sharply." });

    await expect(
      runProfileAgent(llm, { previous, newTransactions: [], stats, categoryLabels: LABELS }),
    ).rejects.toThrow(AppError);
  });

  it("checks the structured fields too, not only the narrative", async () => {
    // A fabricated figure hidden in `habits` reaches the user just as directly.
    const { llm } = stubLlm({ habits: ["Averages 88.88 EUR a day"] });

    await expect(
      runProfileAgent(llm, { previous, newTransactions: [], stats, categoryLabels: LABELS }),
    ).rejects.toMatchObject({ code: "LLM_UNGROUNDED", statusCode: 502 });
  });

  it("sends the instruction prefix as `system` and the volatile payload as `input`", async () => {
    const { llm, requests } = stubLlm({});

    await runProfileAgent(llm, {
      previous,
      newTransactions: [tx(1500, "2026-07-15")],
      stats,
      categoryLabels: LABELS,
    });

    // The cached prefix must not carry per-request data, or it changes every call
    // and caches nothing.
    expect(nth(requests, 0).system).toBe(PROFILE_SYSTEM_PROMPT);
    expect(nth(requests, 0).system).not.toContain("2026-07-15");
    expect(nth(requests, 0).input).toContain("2026-07-15");
    expect(nth(requests, 0).schemaName).toBe("profile_summary");
  });
});
