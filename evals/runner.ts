// Executing one case: the production decision path, minus the database.
//
// The order here mirrors `refreshSuggestions` — aggregate, decide whether there
// is anything to advise on, and only then reach for the model. That ordering is
// itself under test: the degenerate cases pass only if no completion was bought,
// so a runner that called the agent first and filtered afterwards would score
// them zero, which is the correct verdict on that implementation.
//
// The guard itself is *shared*, not copied: both this and `refreshSuggestions`
// call `hasAnythingToAdvise`. A harness holding its own version of the condition
// would keep scoring 100% while the service quietly started paying for
// completions on empty ledgers, which is the one thing gracefulDegradation is
// there to notice. What remains unshared is the surrounding sequence, so moving
// the model call above the guard *in the service* is still not something these
// cases would catch — that belongs to `suggest-refresh`'s own tests.
//
// The two agents are independent passes, not a pipeline, and the harness runs
// them the way production does:
//
//   - `refreshSuggestions` never calls `runProfileAgent`. It reads the last
//     *persisted* summary via `summaries.latest(userId)` and hands that to the
//     suggestion agent. `evalCase.previousSummary` is that value — which is why
//     the freshly computed profile below is scored but deliberately not fed
//     forward. Threading it in would make this harness measure a pipeline the
//     service does not have.
//   - The profiling pass belongs to `POST /profile/refresh`. It is run here so
//     the narrative's grounding is scored too, and it is scored separately.

import type { CategoryTotal, SpendStats } from "../src/domain/types";
import { aggregate, discretionaryByCategory } from "../src/agent/aggregate";
import type { LlmClient } from "../src/agent/anthropic";
import { runProfileAgent, type ProfileAgentResult } from "../src/agent/profile";
import {
  hasAnythingToAdvise,
  runSuggestionAgent,
  suggestibleExpenses,
  type SuggestionAgentResult,
} from "../src/agent/suggest";
import type { EvalCase } from "./cases";
import { CountingLlmClient } from "./stub";

/** What actually happened when a case was run. Scored by `metrics.ts`. */
export type CaseOutcome =
  | { kind: "rejected"; error: Error; llmCalls: number }
  | { kind: "empty"; stats: SpendStats; llmCalls: number }
  | {
      kind: "suggestions";
      stats: SpendStats;
      discretionary: CategoryTotal[];
      /** `null` when the profiling pass failed its own grounding check. */
      profile: ProfileAgentResult | null;
      profileError: Error | null;
      suggestions: SuggestionAgentResult;
      llmCalls: number;
    };

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * Run one case against a client.
 *
 * The suggestion pass is allowed to throw — that is a scoring outcome, not a
 * harness failure — but it is not caught here, because unlike the profiling pass
 * there is no partial result worth reporting. A suggestion agent that throws has
 * produced nothing to ground, and the case scores zero on every metric through
 * the empty result the caller sees.
 */
export async function runCase(inner: LlmClient, evalCase: EvalCase): Promise<CaseOutcome> {
  const llm = new CountingLlmClient(inner);
  const { ledger, period } = evalCase;

  let stats: SpendStats;
  try {
    stats = aggregate(period, ledger);
  } catch (thrown) {
    // A malformed ledger is refused before anything is spent. Reaching the model
    // and failing there would cost the same money and answer nothing.
    return { kind: "rejected", error: asError(thrown), llmCalls: llm.calls };
  }

  const discretionary = discretionaryByCategory(ledger.transactions, ledger.currency);
  const suggestible = suggestibleExpenses(ledger.fixedExpenses, ledger.currency);
  if (!hasAnythingToAdvise(discretionary, suggestible)) {
    return { kind: "empty", stats, llmCalls: llm.calls };
  }

  // The profiling pass throws outright on an ungrounded figure — one narrative
  // cannot be partially trusted. Caught so the suggestion pass is still scored:
  // the two agents fail independently and a report that stopped at the first
  // would hide which one regressed.
  let profile: ProfileAgentResult | null = null;
  let profileError: Error | null = null;
  try {
    profile = await runProfileAgent(llm, {
      previous: evalCase.previousSummary,
      newTransactions: ledger.transactions,
      stats,
      categoryLabels: evalCase.categoryLabels,
    });
  } catch (thrown) {
    profileError = asError(thrown);
  }

  const suggestions = await runSuggestionAgent(llm, {
    profile: evalCase.previousSummary,
    stats,
    discretionaryByCategory: discretionary,
    fixedExpenses: ledger.fixedExpenses,
    categoryLabels: evalCase.categoryLabels,
  });

  return {
    kind: "suggestions",
    stats,
    discretionary,
    profile,
    profileError,
    suggestions,
    llmCalls: llm.calls,
  };
}
