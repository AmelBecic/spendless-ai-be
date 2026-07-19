import { describe, it, expect } from "vitest";
import type { LlmClient, LlmRequest } from "../src/agent/anthropic";
import { CASES, CASE_IDS, TARGET_IDS, type EvalCase } from "./cases";
import { runCase } from "./runner";
import { scriptedLlm } from "./stub";
import { unusedLlm } from "../src/test/stubs";
import { targetOf } from "./metrics";

function caseById(id: string): EvalCase {
  const found = CASES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no eval case "${id}"`);
  return found;
}

const run = (evalCase: EvalCase) => runCase(scriptedLlm(evalCase.script), evalCase);

describe("runCase — the degenerate ledgers cost nothing", () => {
  // `unusedLlm` rejects on any call, so these assert the guard twice over: once on
  // the reported count, and once by failing outright if a completion was reached.
  it.each([CASE_IDS.emptyLedger, CASE_IDS.noNewActivity])(
    "returns an empty feed for %s without calling the model",
    async (id) => {
      const outcome = await runCase(unusedLlm, caseById(id));

      expect(outcome.kind).toBe("empty");
      expect(outcome.llmCalls).toBe(0);
    },
  );

  it("refuses a mixed-currency ledger before spending anything", async () => {
    const outcome = await runCase(unusedLlm, caseById(CASE_IDS.mixedCurrencyLedger));

    expect(outcome.kind).toBe("rejected");
    expect(outcome.llmCalls).toBe(0);
    if (outcome.kind === "rejected") {
      expect(outcome.error.message).toMatch(/currenc/i);
    }
  });

  it("still advises when there is nothing to trim but something to cancel", async () => {
    // The mirror image of the guard above: an implementation that read "nothing to
    // suggest" off the discretionary list alone would return empty here.
    const outcome = await run(caseById(CASE_IDS.commitmentsOnly));

    expect(outcome.kind).toBe("suggestions");
    if (outcome.kind === "suggestions") {
      expect(outcome.suggestions.suggestions).toHaveLength(1);
      expect(targetOf(outcome.suggestions.suggestions[0] ?? never())).toBe(TARGET_IDS.GYM);
    }
  });
});

describe("runCase — the ordinary path", () => {
  it("produces grounded, priced suggestions for a live ledger", async () => {
    const outcome = await run(caseById(CASE_IDS.steadyEater));

    expect(outcome.kind).toBe("suggestions");
    if (outcome.kind !== "suggestions") return;

    // One profiling call plus one suggestion call — the count the live mode bills.
    expect(outcome.llmCalls).toBe(2);
    expect(outcome.profileError).toBeNull();
    expect(outcome.suggestions.dropped).toEqual([]);
    expect(outcome.suggestions.suggestions).toHaveLength(2);

    const figures = outcome.suggestions.suggestions.map(
      (suggestion) => suggestion.estMonthlySavings.amountCents,
    );
    // Hand-computed in cases.ts: food at the moderate lever, and the weekly
    // streaming charge restated per average month.
    expect(figures).toEqual([12175, 4348]);
  });

  it("reports a failed profiling pass without abandoning the suggestions", async () => {
    // A narrative quoting a figure the stats do not contain. The profiling agent
    // throws on it; the suggestion pass is independent and must still be scored.
    const steady = caseById(CASE_IDS.steadyEater);
    const outcome = await runCase(
      scriptedLlm({
        ...steady.script,
        profile: {
          ...steady.script.profile,
          narrative: "You spent 999.99 EUR on food, which is more than last month.",
        },
      }),
      steady,
    );

    expect(outcome.kind).toBe("suggestions");
    if (outcome.kind !== "suggestions") return;

    expect(outcome.profileError).not.toBeNull();
    expect(outcome.profile).toBeNull();
    expect(outcome.suggestions.suggestions).toHaveLength(2);
  });
});

describe("runCase — the returning user", () => {
  it("renders the persisted summary into the suggestion payload", async () => {
    const returning = caseById(CASE_IDS.returningUser);
    const seen: LlmRequest<unknown>[] = [];
    const scripted = scriptedLlm(returning.script);
    const recording: LlmClient = {
      complete: <T>(request: LlmRequest<T>) => {
        seen.push(request as LlmRequest<unknown>);
        return scripted.complete(request);
      },
    };

    const outcome = await runCase(recording, returning);
    expect(outcome.kind).toBe("suggestions");

    // Every other fixture is a first refresh, so without this case the branch that
    // renders a real profile into the payload is never taken — the model would be
    // shown "(none — this user has not been profiled yet)" in all six runs.
    const suggestionRequest = seen.find((request) => request.schemaName === "savings_suggestions");
    expect(suggestionRequest?.input).toContain(
      "Food has consistently been where most of your discretionary money goes.",
    );
    expect(suggestionRequest?.input).not.toContain("has not been profiled yet");
  });
});

describe("scriptedLlm", () => {
  it("rejects a scripted answer the real schema would not have accepted", async () => {
    const steady = caseById(CASE_IDS.steadyEater);
    const outcome = runCase(
      scriptedLlm({
        ...steady.script,
        // `lever` is a closed enum in the agent's schema; the seam would never
        // hand this back, so the harness must not let a fixture pretend it did.
        suggestions: [
          {
            ...(steady.script.suggestions[0] ?? never()),
            lever: "catastrophic" as unknown as "moderate",
          },
        ],
      }),
      steady,
    );

    await expect(outcome).rejects.toThrow(/does not satisfy its schema/);
  });
});

/** Narrows an indexed read the compiler cannot prove is present. */
function never(): never {
  throw new Error("fixture is missing an expected entry");
}
