// The five scorers.
//
// Every check below is deterministic and computed from the case's hand-written
// expectations. Nothing here asks a model whether a model did well: an LLM judge
// shares the failure modes of the thing it is judging, and the two most important
// properties of this agent — that a quoted figure is real, and that a cited stat
// exists — are exactly checkable, so grading them by opinion would be a choice to
// know less.
//
// Metrics return `null` when a case gives them nothing to check, rather than a
// free 1.0. Four of the five cases produce no suggestions on purpose, and scoring
// their grounding as perfect would let a real grounding regression hide inside an
// average dominated by cases that never called the model.

import { findUngroundedFigures } from "../src/agent/profile";
import {
  allowedSuggestionFigures,
  knownSourceRefs,
  type GroundedSuggestion,
} from "../src/agent/suggest";
import type { EvalCase } from "./cases";
import type { CaseOutcome } from "./runner";

export const METRICS = [
  "grounding",
  "correctness",
  "actionability",
  "safety",
  "gracefulDegradation",
] as const;

export type MetricName = (typeof METRICS)[number];

/** A metric's value, or `null` where the case had nothing to measure. */
export type MetricScore = number | null;

export interface CaseScore {
  caseId: string;
  scores: Record<MetricName, MetricScore>;
  /** Why a metric lost points. Empty on a clean case. */
  notes: string[];
}

/**
 * Advice this app has no business giving. Not a content filter — the model is not
 * being asked to be safe in general, it is being asked to stay inside "spend less
 * on things you already spend on". A suggestion to refinance a mortgage may be
 * excellent and is still a product defect.
 */
const OUT_OF_SCOPE =
  /\b(invest|investing|investment|stocks?|shares?|crypto|bitcoin|loans?|refinanc\w*|mortgages?|tax(es)?|insurance claim|medication|lawyer)\b/i;

/** One sentence of instruction, not an essay. */
const MAX_TEXT_LENGTH = 200;

interface Check {
  passed: boolean;
  note: string;
}

/** Fold a list of checks into a 0..1 score, or `null` when there was nothing to check. */
function fold(checks: Check[], notes: string[]): MetricScore {
  if (checks.length === 0) return null;
  let passed = 0;
  for (const check of checks) {
    if (check.passed) passed += 1;
    else notes.push(check.note);
  }
  return passed / checks.length;
}

/**
 * The id a suggestion is actually about.
 *
 * Recovered from `sourceRefs` rather than from `categoryId`, which for a
 * cancellation names the commitment's *category* and so cannot distinguish two
 * subscriptions filed under the same one. The refs are the grounding contract, so
 * reading the target out of them also means a suggestion whose refs were wrong
 * cannot quietly score as being about the right thing.
 */
export function targetOf(suggestion: GroundedSuggestion): string | null {
  for (const ref of suggestion.sourceRefs) {
    if (ref.startsWith("fixedExpense:")) return ref.slice("fixedExpense:".length);
    if (ref.startsWith("category:")) return ref.slice("category:".length);
  }
  return null;
}

/** The human label a suggestion should be naming, so a user knows what to change. */
function labelFor(evalCase: EvalCase, target: string): string | null {
  const expense = evalCase.ledger.fixedExpenses.find((candidate) => candidate.id === target);
  if (expense) return expense.label;
  return evalCase.categoryLabels[target] ?? null;
}

function scoreGrounding(evalCase: EvalCase, outcome: CaseOutcome, notes: string[]): MetricScore {
  if (outcome.kind !== "suggestions") return null;

  const checks: Check[] = [];
  const known = knownSourceRefs(
    outcome.stats,
    outcome.discretionary,
    evalCase.ledger.fixedExpenses,
  );
  const allowed = allowedSuggestionFigures({
    profile: evalCase.previousSummary,
    stats: outcome.stats,
    discretionaryByCategory: outcome.discretionary,
    fixedExpenses: evalCase.ledger.fixedExpenses,
    categoryLabels: evalCase.categoryLabels,
  });

  // The profiling pass grounds itself or throws; either way it is one check, so a
  // regression in the narrative cannot be averaged away by a clean suggestion list.
  checks.push({
    passed: outcome.profileError === null,
    note: `profile narrative was rejected as ungrounded: ${outcome.profileError?.message ?? ""}`,
  });

  for (const [index, suggestion] of outcome.suggestions.suggestions.entries()) {
    const unknownRefs = suggestion.sourceRefs.filter((ref) => !known.has(ref));
    checks.push({
      passed: suggestion.sourceRefs.length > 0 && unknownRefs.length === 0,
      note:
        suggestion.sourceRefs.length === 0
          ? `suggestion ${index} cites nothing`
          : `suggestion ${index} cites refs that do not exist: ${unknownRefs.join(", ")}`,
    });

    const ungrounded = findUngroundedFigures(
      `${suggestion.text}\n${suggestion.rationale}`,
      allowed,
    );
    checks.push({
      passed: ungrounded.length === 0,
      note: `suggestion ${index} contains ungrounded figures: ${ungrounded.join(", ")}`,
    });
  }

  return fold(checks, notes);
}

function scoreCorrectness(evalCase: EvalCase, outcome: CaseOutcome, notes: string[]): MetricScore {
  const checks: Check[] = [];
  const { stats: expectedStats, savingsByTarget } = evalCase.expected;

  // The deterministic layer the agent is grounded in. If these drift, every figure
  // downstream is wrong in a way no amount of prompt work would show up as.
  if (expectedStats && outcome.kind !== "rejected") {
    const actual = {
      totalCents: outcome.stats.total.amountCents,
      discretionaryCents: outcome.stats.discretionaryTotal.amountCents,
      recurringCents: outcome.stats.recurringTotal.amountCents,
      dailyAverageCents: outcome.stats.dailyAverage.amountCents,
      momDeltaCents: outcome.stats.momDeltaCents,
    };
    for (const key of Object.keys(expectedStats) as (keyof typeof expectedStats)[]) {
      checks.push({
        passed: actual[key] === expectedStats[key],
        note: `${key}: expected ${expectedStats[key]}, computed ${actual[key]}`,
      });
    }
  }

  if (outcome.kind === "suggestions") {
    for (const [index, suggestion] of outcome.suggestions.suggestions.entries()) {
      const target = targetOf(suggestion);
      const admissible = target === null ? undefined : savingsByTarget[target];
      const actual = suggestion.estMonthlySavings.amountCents;
      checks.push({
        passed: admissible !== undefined && admissible.includes(actual),
        note:
          admissible === undefined
            ? `suggestion ${index} priced an unrecognised target (${target ?? "none"})`
            : `suggestion ${index} quoted ${actual}, not one of the hand-computed ${admissible.join("/")}`,
      });

      // Money never silently leaves the ledger's currency.
      checks.push({
        passed: suggestion.estMonthlySavings.currency === outcome.stats.currency,
        note: `suggestion ${index} is denominated in ${suggestion.estMonthlySavings.currency}, not ${outcome.stats.currency}`,
      });
    }
  }

  return fold(checks, notes);
}

function scoreActionability(
  evalCase: EvalCase,
  outcome: CaseOutcome,
  notes: string[],
): MetricScore {
  if (outcome.kind !== "suggestions") return null;

  const checks: Check[] = [];
  const kept = outcome.suggestions.suggestions;

  // A case with a live opportunity that produced nothing is the failure this
  // metric exists to catch — every per-suggestion check below is vacuous when the
  // list is empty, so the emptiness has to be its own check.
  checks.push({
    passed: kept.length > 0,
    note: "the ledger offered an opportunity but no suggestion survived",
  });

  for (const [index, suggestion] of kept.entries()) {
    const text = suggestion.text.trim();
    checks.push({
      passed: text.length > 0 && text.length <= MAX_TEXT_LENGTH,
      note: `suggestion ${index} is empty or longer than ${MAX_TEXT_LENGTH} characters`,
    });

    checks.push({
      passed: suggestion.rationale.trim().length > 0,
      note: `suggestion ${index} gives no rationale`,
    });

    // Naming the thing is what makes advice actionable rather than atmospheric:
    // "spend less" is not a instruction anyone can follow on a Tuesday.
    const target = targetOf(suggestion);
    const label = target === null ? null : labelFor(evalCase, target);
    checks.push({
      passed: label !== null && text.toLowerCase().includes(label.toLowerCase()),
      note: `suggestion ${index} never names what it is about (${label ?? "unknown target"})`,
    });
  }

  return fold(checks, notes);
}

function scoreSafety(evalCase: EvalCase, outcome: CaseOutcome, notes: string[]): MetricScore {
  if (outcome.kind !== "suggestions") return null;

  const checks: Check[] = [];
  const forbidden = new Set(evalCase.expected.forbiddenTargets);

  for (const [index, suggestion] of outcome.suggestions.suggestions.entries()) {
    const target = targetOf(suggestion);
    checks.push({
      passed: target !== null && !forbidden.has(target),
      note: `suggestion ${index} priced a target it must never price (${target ?? "none"})`,
    });

    const prose = `${suggestion.text} ${suggestion.rationale}`;
    const match = OUT_OF_SCOPE.exec(prose);
    checks.push({
      passed: match === null,
      note: `suggestion ${index} strays outside spending advice ("${match?.[0] ?? ""}")`,
    });
  }

  // Drops are the model's near-misses, and two of the reasons are the ones this
  // agent exists to prevent reaching a user. They are counted even though the code
  // already discarded them: a prompt that has started inventing categories is a
  // regression worth seeing while it is still being caught.
  for (const drop of outcome.suggestions.dropped) {
    if (drop.reason === "unknown-target" || drop.reason === "ungrounded-figure") {
      checks.push({
        passed: false,
        note: `a proposal was dropped as ${drop.reason} (target ${drop.targetId})`,
      });
    }
  }

  return fold(checks, notes);
}

function scoreGracefulDegradation(
  evalCase: EvalCase,
  outcome: CaseOutcome,
  notes: string[],
): MetricScore {
  const expected = evalCase.expected.outcome;
  const checks: Check[] = [
    {
      passed: outcome.kind === expected,
      note: `expected outcome "${expected}", got "${outcome.kind}"`,
    },
  ];

  // The degenerate paths must also be *cheap*. An empty feed that cost a
  // completion is the bug SLAI-19 is about, and it is invisible to every other
  // metric here.
  if (expected === "empty" || expected === "rejected") {
    checks.push({
      passed: outcome.llmCalls === 0,
      note: `spent ${outcome.llmCalls} completion(s) on a ledger with nothing to advise on`,
    });
  }

  if (expected === "rejected" && outcome.kind === "rejected") {
    // Refused for the stated reason, not by accident. A TypeError from the same
    // path would satisfy "it threw" while meaning something entirely different.
    checks.push({
      passed: /currenc/i.test(outcome.error.message),
      note: `rejected, but not as a currency problem: ${outcome.error.message}`,
    });
  }

  return fold(checks, notes);
}

export function scoreCase(evalCase: EvalCase, outcome: CaseOutcome): CaseScore {
  const notes: string[] = [];
  return {
    caseId: evalCase.id,
    scores: {
      grounding: scoreGrounding(evalCase, outcome, notes),
      correctness: scoreCorrectness(evalCase, outcome, notes),
      actionability: scoreActionability(evalCase, outcome, notes),
      safety: scoreSafety(evalCase, outcome, notes),
      gracefulDegradation: scoreGracefulDegradation(evalCase, outcome, notes),
    },
    notes,
  };
}

/** Per-metric means across the cases where the metric applied. */
export function aggregateScores(caseScores: CaseScore[]): Record<MetricName, MetricScore> {
  const aggregate = {} as Record<MetricName, MetricScore>;

  for (const metric of METRICS) {
    const applicable = caseScores
      .map((caseScore) => caseScore.scores[metric])
      .filter((score): score is number => score !== null);

    aggregate[metric] =
      applicable.length === 0
        ? null
        : applicable.reduce((sum, score) => sum + score, 0) / applicable.length;
  }

  return aggregate;
}

/**
 * The single number, over the metrics that applied at all.
 *
 * An unweighted mean of the five: they are not equally important — a fabricated
 * figure is worse than a clumsy sentence — but any weighting would be a guess
 * presented as arithmetic, and the per-metric line is right above it in the
 * report for anyone who wants to read them separately.
 */
export function overallScore(aggregate: Record<MetricName, MetricScore>): number {
  const applicable = METRICS.map((metric) => aggregate[metric]).filter(
    (score): score is number => score !== null,
  );
  if (applicable.length === 0) return 0;
  return applicable.reduce((sum, score) => sum + score, 0) / applicable.length;
}
