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
import { scoreCase, type CaseScore } from "./metrics";
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

const BASELINE_PATH = fileURLToPath(new URL("./baseline.json", import.meta.url));

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
    caseScores.push(scoreCase(evalCase, await runCase(llm, evalCase)));
  }

  const report = buildReport(options.mode, caseScores);
  console.log(formatReport(report));

  if (options.updateBaseline) {
    writeBaseline(BASELINE_PATH, toBaseline(report));
    console.log(`\nbaseline updated: ${BASELINE_PATH}`);
    return;
  }

  const regressions = compareToBaseline(report, readBaseline(BASELINE_PATH));
  if (regressions.length > 0) {
    console.error(`\nregressed against the baseline:`);
    for (const regression of regressions) console.error(`  - ${regression}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nno regression against the baseline.");
}

await main();
