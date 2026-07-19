// `npm run eval` — run every case, print the scores, fail on regression.
//
// Two modes, and the difference matters when reading the numbers:
//
//   stub (default)  The model is scripted, so the scores measure the *code* — the
//                   arithmetic behind every figure, the grounding checks, the
//                   guards that decide whether a completion is bought at all. It
//                   is deterministic, costs nothing, and is the mode CI can gate
//                   on. A drop here is a code regression, full stop.
//   live (--live)   The real model answers. The same scorers now measure the
//                   prompt: whether Opus, given this ledger, cites real stats and
//                   stays inside its remit. Non-deterministic and it spends money,
//                   so it is run deliberately and baselined separately.
//
// The scorers are identical across both. That is the design: the harness never
// asks a model to grade a model, so nothing about it needs to change when the
// answers stop being scripted.

import { fileURLToPath } from "node:url";
import { CASES } from "./cases";
import { METRICS, scoreCase, type CaseScore, type MetricName } from "./metrics";
import {
  buildReport,
  compareToBaseline,
  formatReport,
  readBaseline,
  toBaseline,
  writeBaseline,
  type EvalMode,
} from "./report";
import { runCase } from "./runner";
import { scriptedLlm } from "./stub";
import { createAnthropicLlmClient } from "../src/agent/anthropic";
import type { LlmClient } from "../src/agent/anthropic";

/**
 * One baseline file per mode.
 *
 * A single shared path would mean `--live --update-baseline` silently overwrites
 * the stub baseline that gates CI, and every subsequent stub run would then fail
 * on the mode-mismatch guard until someone re-recorded it by hand. The guard is a
 * safety valve, not a reason to let the footgun exist.
 */
function baselinePath(mode: EvalMode): string {
  const name = mode === "live" ? "baseline.live.json" : "baseline.json";
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

interface Options {
  mode: EvalMode;
  updateBaseline: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "stub", updateBaseline: false };

  for (const arg of argv) {
    if (arg === "--live") options.mode = "live";
    else if (arg === "--update-baseline") options.updateBaseline = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: npm run eval [-- --live] [-- --update-baseline]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return options;
}

/** The live client, or a clear failure. A silent fallback to the stub would report a score that measured nothing. */
function liveClient(): LlmClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) {
    console.error("--live needs ANTHROPIC_API_KEY in the environment.");
    process.exit(2);
  }
  return createAnthropicLlmClient({
    apiKey,
    // Straight to stderr, so the harness's own stdout stays the report and can be
    // piped somewhere without the seam's telemetry landing in the middle of it.
    logger: {
      info: (details, message) => console.error(message, details),
      warn: (details, message) => console.error(message, details),
      error: (details, message) => console.error(message, details),
    },
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Built once, before any case runs: a missing key should fail on the first line
  // of output rather than partway through a scored run, and the SDK client holds
  // the connection pool and the request timeout that bound every live call.
  const live = options.mode === "live" ? liveClient() : null;

  const caseScores: CaseScore[] = [];
  for (const evalCase of CASES) {
    // Sequential on purpose. In live mode these are billable calls against a
    // shared rate limit, and a fan-out would trade a slower suite for flakier
    // numbers.
    const llm = live ?? scriptedLlm(evalCase.script);
    try {
      caseScores.push(scoreCase(evalCase, await runCase(llm, evalCase)));
    } catch (thrown) {
      // One case must not take the run down. In live mode a single 429 or timeout
      // on the fourth case would otherwise discard three cases' worth of billable
      // calls and print no report at all. Scored as a hard zero, which is honest —
      // a case that could not be run did not pass — and visible in the notes.
      caseScores.push(failedCase(evalCase.id, thrown));
    }
  }

  const report = buildReport(options.mode, caseScores);
  console.log(formatReport(report));

  const path = baselinePath(options.mode);

  if (options.updateBaseline) {
    writeBaseline(path, toBaseline(report));
    console.log(`\nbaseline updated: ${path}`);
    return;
  }

  const regressions = compareToBaseline(report, readBaseline(path));
  if (regressions.length > 0) {
    console.error(`\nregressed against the baseline:`);
    for (const regression of regressions) console.error(`  - ${regression}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nno regression against the baseline.");
}

/** A case that could not be run at all: zero everywhere, with the reason recorded. */
function failedCase(caseId: string, thrown: unknown): CaseScore {
  const scores = {} as Record<MetricName, number>;
  for (const metric of METRICS) scores[metric] = 0;
  return {
    caseId,
    scores,
    notes: [
      `the case could not be run: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    ],
  };
}

// Exit 2, not 1: a harness that fell over is a different answer from a run that
// completed and scored badly, and a CI job should be able to tell them apart.
main().catch((thrown: unknown) => {
  console.error(
    `\neval harness failed: ${thrown instanceof Error ? thrown.stack : String(thrown)}`,
  );
  process.exitCode = 2;
});
