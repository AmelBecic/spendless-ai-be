// A scripted stand-in for the model, and the call counter both modes share.
//
// The stub answers from the case's script instead of the API, which is what makes
// `npm run eval` runnable in CI and on a machine with no key. It is not a
// convenience shim: it validates every scripted answer against the same zod
// schema the real seam validates completions against, so a script that could not
// have come back from the model fails here rather than quietly scoring well.

import type { LlmClient, LlmRequest, LlmResult, LlmUsage } from "../src/agent/anthropic";
import type { ScriptedProfile, ScriptedProposal } from "./cases";

/** Zero usage — a stubbed run spends nothing, and reporting otherwise would be a lie. */
const NO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  estimatedCostUsd: 0,
};

/**
 * An `LlmClient` that counts calls and forwards to `inner`.
 *
 * Wrapping rather than instrumenting the client itself keeps the count available
 * in both modes: "did this ledger cost a completion?" is a question about the
 * live path too, and on the degenerate cases it is the entire assertion.
 */
export class CountingLlmClient implements LlmClient {
  calls = 0;
  readonly usage: LlmUsage = { ...NO_USAGE };

  constructor(private readonly inner: LlmClient) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls += 1;
    const result = await this.inner.complete(request);
    this.usage.inputTokens += result.usage.inputTokens;
    this.usage.outputTokens += result.usage.outputTokens;
    this.usage.cacheCreationInputTokens += result.usage.cacheCreationInputTokens;
    this.usage.cacheReadInputTokens += result.usage.cacheReadInputTokens;
    this.usage.estimatedCostUsd += result.usage.estimatedCostUsd;
    return result;
  }
}

export interface Script {
  profile: ScriptedProfile;
  suggestions: ScriptedProposal[];
}

/**
 * Answer from a script, dispatching on the call site's `schemaName`.
 *
 * Dispatching on the label rather than the call order is deliberate: the order
 * the two agents run in is the runner's business, and a stub that assumed it
 * would start returning suggestions to the profiling agent the day that changed.
 */
export function scriptedLlm(script: Script): LlmClient {
  return {
    complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const payload =
        request.schemaName === "profile_summary"
          ? script.profile
          : { suggestions: script.suggestions };

      // Parsed, not cast. The scripted answer has to satisfy the very schema the
      // seam would have enforced, so a fixture cannot describe a completion the
      // model was never able to produce.
      const parsed = request.schema.safeParse(payload);
      if (!parsed.success) {
        return Promise.reject(
          new Error(
            `scripted answer for "${request.schemaName}" does not satisfy its schema: ` +
              parsed.error.issues.map((issue) => issue.message).join("; "),
          ),
        );
      }

      return Promise.resolve({ data: parsed.data, usage: { ...NO_USAGE } });
    },
  };
}
