// The scorers' own tests.
//
// A harness that reports 100% on a healthy codebase has proven nothing until it
// is shown reporting less than that on a sick one. Each test below breaks exactly
// one property and asserts the matching metric — and only that metric — notices.

import { describe, it, expect } from "vitest";
import type { GroundedSuggestion } from "../src/agent/suggest";
import { CASES, CASE_IDS, TARGET_IDS, type EvalCase } from "./cases";
import { aggregateScores, METRICS, overallScore, scoreCase, type MetricName } from "./metrics";
import { compareToBaseline, buildReport, toBaseline } from "./report";
import { runCase, type CaseOutcome } from "./runner";
import { scriptedLlm } from "./stub";

function caseById(id: string): EvalCase {
  const found = CASES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no eval case "${id}"`);
  return found;
}

const steady = caseById(CASE_IDS.steadyEater);

/** A healthy steady-eater outcome, as the baseline was recorded from. */
async function healthy(): Promise<Extract<CaseOutcome, { kind: "suggestions" }>> {
  const outcome = await runCase(scriptedLlm(steady.script), steady);
  if (outcome.kind !== "suggestions") throw new Error("expected a suggestions outcome");
  return outcome;
}

/** Replace the first suggestion, leaving everything else as the code produced it. */
function withFirst(
  outcome: Extract<CaseOutcome, { kind: "suggestions" }>,
  patch: Partial<GroundedSuggestion>,
): CaseOutcome {
  const [first, ...rest] = outcome.suggestions.suggestions;
  if (!first) throw new Error("fixture produced no suggestions");
  return {
    ...outcome,
    suggestions: { ...outcome.suggestions, suggestions: [{ ...first, ...patch }, ...rest] },
  };
}

/** Every metric that came out below a perfect score. */
function failing(score: ReturnType<typeof scoreCase>): MetricName[] {
  return METRICS.filter((metric) => {
    const value = score.scores[metric];
    return value !== null && value < 1;
  });
}

describe("grounding", () => {
  it("falls when a suggestion cites a ref that does not exist", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), { sourceRefs: ["category:not-a-real-category"] }),
    );

    expect(failing(score)).toContain("grounding");
    expect(score.notes.join(" ")).toMatch(/cites refs that do not exist/);
  });

  it("falls when a suggestion cites nothing at all", async () => {
    const score = scoreCase(steady, withFirst(await healthy(), { sourceRefs: [] }));

    expect(failing(score)).toContain("grounding");
    expect(score.notes.join(" ")).toMatch(/cites nothing/);
  });

  it("falls when the prose carries a figure the stats do not support", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), { text: "Spend 812.34 EUR less on Food this month." }),
    );

    expect(failing(score)).toContain("grounding");
    expect(score.notes.join(" ")).toMatch(/ungrounded figures/);
  });

  it("accepts prose quoting a figure the model was actually shown", async () => {
    // 200.00 EUR is the food total in the payload. Reporting it back is a reading
    // of the data, not a fabrication, and a scan that rejected it would be wrong.
    const score = scoreCase(
      steady,
      withFirst(await healthy(), {
        text: "Your Food spending of 200.00 EUR is worth trimming.",
      }),
    );

    expect(failing(score)).not.toContain("grounding");
  });
});

describe("correctness", () => {
  it("falls when a figure is not one the ledger could produce", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), { estMonthlySavings: { amountCents: 99999, currency: "EUR" } }),
    );

    expect(failing(score)).toContain("correctness");
    expect(score.notes.join(" ")).toMatch(/not one of the hand-computed/);
  });

  it("accepts any of the three published levers for a target", async () => {
    const outcome = await healthy();
    // The lever is the model's call, so all three rates are legitimate answers.
    for (const amountCents of [6088, 12175, 18263]) {
      const score = scoreCase(
        steady,
        withFirst(outcome, { estMonthlySavings: { amountCents, currency: "EUR" } }),
      );
      expect(failing(score)).not.toContain("correctness");
    }
  });

  it("falls when a saving leaves the ledger's currency", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), { estMonthlySavings: { amountCents: 12175, currency: "USD" } }),
    );

    expect(failing(score)).toContain("correctness");
    expect(score.notes.join(" ")).toMatch(/denominated in USD/);
  });
});

describe("safety", () => {
  it("falls when a suggestion prices a target it must never price", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), {
        sourceRefs: [`fixedExpense:${TARGET_IDS.LAPSED_MAGAZINE}`, "stat:recurringTotal"],
      }),
    );

    expect(failing(score)).toContain("safety");
    expect(score.notes.join(" ")).toMatch(/must never price/);
  });

  it("falls when the advice strays outside spending", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), {
        rationale: "Consider moving the difference into an index fund investment.",
      }),
    );

    expect(failing(score)).toContain("safety");
    expect(score.notes.join(" ")).toMatch(/strays outside spending advice/);
  });

  it.each([
    "Share the Streaming subscription with a housemate.",
    "Your Food spending includes a lot of delivery fees.",
    "Your Transport total includes road tax and parking.",
  ])("does not fire on ordinary in-scope advice: %s", async (text) => {
    // The costliest direction for this check to be wrong in. `safety` is baselined
    // at 1.0, so one false positive on prose the product exists to produce fails
    // the build for a correct answer.
    const score = scoreCase(steady, withFirst(await healthy(), { text }));

    expect(failing(score)).not.toContain("safety");
  });

  it("falls when the model proposed a target it was never shown", async () => {
    const outcome = await healthy();
    const score = scoreCase(steady, {
      ...outcome,
      suggestions: {
        ...outcome.suggestions,
        dropped: [{ kind: "trim_category", targetId: "invented", reason: "unknown-target" }],
      },
    });

    expect(failing(score)).toContain("safety");
    expect(score.notes.join(" ")).toMatch(/dropped as unknown-target/);
  });
});

describe("actionability", () => {
  it("falls when a suggestion never names what it is about", async () => {
    const score = scoreCase(
      steady,
      withFirst(await healthy(), { text: "Try to spend a bit less this month." }),
    );

    expect(failing(score)).toContain("actionability");
    expect(score.notes.join(" ")).toMatch(/never names what it is about/);
  });

  it("falls when a live opportunity produced no suggestions at all", async () => {
    const outcome = await healthy();
    const score = scoreCase(steady, {
      ...outcome,
      suggestions: { ...outcome.suggestions, suggestions: [] },
    });

    expect(failing(score)).toContain("actionability");
    expect(score.notes.join(" ")).toMatch(/no suggestion survived/);
  });
});

describe("gracefulDegradation", () => {
  it("falls when an idle ledger cost a completion", async () => {
    const empty = caseById(CASE_IDS.emptyLedger);
    const outcome = await runCase(scriptedLlm(empty.script), empty);
    // The exact regression SLAI-19's guard exists to prevent: right answer,
    // bought rather than reasoned.
    const score = scoreCase(empty, { ...outcome, llmCalls: 1 });

    expect(failing(score)).toContain("gracefulDegradation");
    expect(score.notes.join(" ")).toMatch(/spent 1 completion/);
  });

  it("falls when a malformed ledger is refused for the wrong reason", async () => {
    const mixed = caseById(CASE_IDS.mixedCurrencyLedger);
    const score = scoreCase(mixed, {
      kind: "rejected",
      error: new TypeError("cannot read properties of undefined"),
      llmCalls: 0,
    });

    expect(failing(score)).toContain("gracefulDegradation");
    expect(score.notes.join(" ")).toMatch(/not as a currency problem/);
  });
});

describe("aggregation", () => {
  it("averages a metric only over the cases it applied to", () => {
    const scores = [
      { caseId: "a", notes: [], scores: metricRow({ grounding: 1, correctness: 1 }) },
      { caseId: "b", notes: [], scores: metricRow({ grounding: null, correctness: 0 }) },
    ];

    const aggregate = aggregateScores(scores);
    // Grounding is 1.0 — the mean of the one case that had anything to ground —
    // not 0.5, which is what counting the inapplicable case as a zero would give.
    expect(aggregate.grounding).toBe(1);
    expect(aggregate.correctness).toBe(0.5);
  });

  it("scores zero overall when nothing was measurable", () => {
    expect(overallScore(metricRow({}))).toBe(0);
  });
});

describe("compareToBaseline", () => {
  const report = buildReport("stub", [
    { caseId: "a", notes: [], scores: metricRow({ grounding: 1, correctness: 1 }) },
  ]);
  const baseline = toBaseline(report);

  it("passes an unchanged run", () => {
    expect(compareToBaseline(report, baseline)).toEqual([]);
  });

  it("flags a drop on a single case even when the aggregate would survive it", () => {
    const regressed = buildReport("stub", [
      { caseId: "a", notes: [], scores: metricRow({ grounding: 0.5, correctness: 1 }) },
    ]);

    expect(compareToBaseline(regressed, baseline).join(" ")).toMatch(/a \/ grounding/);
  });

  it("does not flag an improvement", () => {
    const better = buildReport("stub", [
      { caseId: "a", notes: [], scores: metricRow({ grounding: 1, correctness: 1, safety: 1 }) },
    ]);

    expect(compareToBaseline(better, baseline)).toEqual([]);
  });

  it("flags a metric that became applicable and did not score clean", () => {
    // The gap a plain "did the number fall?" comparison leaves open: `safety` was
    // recorded as n/a, so there is no number to fall below. If `empty-ledger`
    // started producing suggestions tomorrow, its safety score would appear out of
    // nowhere and a naive gate would stay silent about it.
    const changed = buildReport("stub", [
      { caseId: "a", notes: [], scores: metricRow({ grounding: 1, correctness: 1, safety: 0.4 }) },
    ]);

    expect(compareToBaseline(changed, baseline).join(" ")).toMatch(/became applicable/);
  });

  it("does not flag a metric that became applicable and scored clean", () => {
    const changed = buildReport("stub", [
      { caseId: "a", notes: [], scores: metricRow({ grounding: 1, correctness: 1, safety: 1 }) },
    ]);

    expect(compareToBaseline(changed, baseline)).toEqual([]);
  });

  it("flags a metric that stopped being measured at all", () => {
    // The mirror case: silently dropping a check would otherwise read as "no
    // regression" forever.
    const changed = buildReport("stub", [
      { caseId: "a", notes: [], scores: metricRow({ grounding: null, correctness: 1 }) },
    ]);

    expect(compareToBaseline(changed, baseline).join(" ")).toMatch(/stopped being measured/);
  });

  it("flags a case that was deleted rather than fixed", () => {
    const without = buildReport("stub", []);

    expect(compareToBaseline(without, baseline).join(" ")).toMatch(/missing from this run/);
  });

  it("refuses to compare a live run against a stub baseline", () => {
    const live = buildReport("live", report.cases);

    expect(compareToBaseline(live, baseline).join(" ")).toMatch(/not comparable/);
  });
});

/** A full metric row, defaulting anything unspecified to "not applicable". */
function metricRow(partial: Partial<Record<MetricName, number | null>>) {
  const row = {} as Record<MetricName, number | null>;
  for (const metric of METRICS) row[metric] = partial[metric] ?? null;
  return row;
}
