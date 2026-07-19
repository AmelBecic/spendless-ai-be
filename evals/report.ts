// Turning scores into a report, a committed baseline, and a verdict.

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  aggregateScores,
  METRICS,
  overallScore,
  type CaseScore,
  type MetricName,
  type MetricScore,
} from "./metrics";

/** Which client the run used. Baselines are per-mode: the two are not comparable. */
export type EvalMode = "stub" | "live";

export interface EvalReport {
  mode: EvalMode;
  cases: CaseScore[];
  metrics: Record<MetricName, MetricScore>;
  overall: number;
}

const MetricScoreSchema = z.number().min(0).max(1).nullable();

const BaselineSchema = z.object({
  mode: z.enum(["stub", "live"]),
  /** ISO-8601. Informational — a stale baseline is a review question, not a gate. */
  recordedAt: z.string(),
  overall: z.number(),
  metrics: z.record(z.string(), MetricScoreSchema),
  /** Per-case, per-metric. Compared individually — see `compareToBaseline`. */
  cases: z.record(z.string(), z.record(z.string(), MetricScoreSchema)),
});

export type Baseline = z.infer<typeof BaselineSchema>;

/**
 * Float slack. Scores are means of small integer counts, so exact equality would
 * hold in practice — but a metric that gains a sixth check goes from thirds to
 * sixths, and failing a run over the last bit of a double would be noise, not a
 * regression.
 */
const EPSILON = 1e-9;

export function buildReport(mode: EvalMode, cases: CaseScore[]): EvalReport {
  const metrics = aggregateScores(cases);
  return { mode, cases, metrics, overall: overallScore(metrics) };
}

export function toBaseline(report: EvalReport): Baseline {
  const cases: Record<string, Record<string, MetricScore>> = {};
  for (const caseScore of report.cases) cases[caseScore.caseId] = { ...caseScore.scores };

  return {
    mode: report.mode,
    recordedAt: new Date().toISOString(),
    overall: report.overall,
    metrics: { ...report.metrics },
    cases,
  };
}

export function readBaseline(path: string): Baseline {
  return BaselineSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

/**
 * Every way this run is worse than the baseline.
 *
 * Compared per case *and* per metric, not just on the aggregate. Two cases moving
 * in opposite directions cancel out in a mean, and "grounding held at 0.9" while
 * one user's suggestions stopped being grounded at all is precisely the regression
 * this is meant to catch. Improvements are not failures — the gate is one-sided,
 * and a run that gets better simply passes until someone re-records the baseline.
 */
export function compareToBaseline(report: EvalReport, baseline: Baseline): string[] {
  const regressions: string[] = [];

  if (report.mode !== baseline.mode) {
    regressions.push(
      `baseline was recorded in "${baseline.mode}" mode but this run is "${report.mode}" — scores are not comparable`,
    );
    return regressions;
  }

  /**
   * Why this run is worse on one metric, or `null` if it is not.
   *
   * The `null` baseline case is the subtle one. A metric recorded as `n/a` has no
   * number to fall below, so a naive comparison leaves it permanently ungated —
   * and four of the six cases carry nulls. If a regression makes `empty-ledger`
   * start producing suggestions, its grounding goes from `n/a` to some real score,
   * and treating that as "nothing to compare" means the gate stays silent while
   * the applicability set changed underneath it. A metric that became applicable
   * and did not score perfectly is therefore reported in its own right.
   */
  const regressionOf = (was: MetricScore, now: MetricScore): string | null => {
    if (was === null) {
      if (now === null || now >= 1 - EPSILON) return null;
      return `${format(now)} (baseline n/a — this metric became applicable and did not score clean)`;
    }
    if (now === null) return `n/a (baseline ${format(was)} — this metric stopped being measured)`;
    if (now < was - EPSILON) return `${format(now)} (baseline ${format(was)})`;
    return null;
  };

  for (const metric of METRICS) {
    const change = regressionOf(baseline.metrics[metric] ?? null, report.metrics[metric]);
    if (change) regressions.push(`${metric}: ${change}`);
  }

  for (const caseScore of report.cases) {
    const baselineCase = baseline.cases[caseScore.caseId];
    if (!baselineCase) continue; // A new case has nothing to regress against.
    for (const metric of METRICS) {
      const change = regressionOf(baselineCase[metric] ?? null, caseScore.scores[metric]);
      if (change) regressions.push(`${caseScore.caseId} / ${metric}: ${change}`);
    }
  }

  // A case that vanished cannot regress, but it also cannot pass — deleting the
  // one failing fixture is otherwise the cheapest way to make this suite green.
  for (const caseId of Object.keys(baseline.cases)) {
    if (!report.cases.some((caseScore) => caseScore.caseId === caseId)) {
      regressions.push(`${caseId}: in the baseline but missing from this run`);
    }
  }

  return regressions;
}

function format(score: MetricScore): string {
  return score === null ? "  n/a" : `${(score * 100).toFixed(1)}%`;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [`spendless-ai evals — ${report.mode} mode`, ""];

  for (const caseScore of report.cases) {
    const summary = METRICS.map((metric) => `${metric} ${format(caseScore.scores[metric])}`).join(
      "  ",
    );
    const clean = METRICS.every((metric) => {
      const score = caseScore.scores[metric];
      return score === null || score >= 1 - EPSILON;
    });
    lines.push(`${clean ? "PASS" : "FAIL"}  ${caseScore.caseId}`);
    lines.push(`      ${summary}`);
    for (const note of caseScore.notes) lines.push(`      - ${note}`);
    lines.push("");
  }

  lines.push("aggregate");
  for (const metric of METRICS) {
    lines.push(`  ${metric.padEnd(20)} ${format(report.metrics[metric])}`);
  }
  lines.push(`  ${"overall".padEnd(20)} ${format(report.overall)}`);

  return lines.join("\n");
}
