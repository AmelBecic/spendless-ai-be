// The incremental profiling loop.
//
// Two rules shape this file. First, it is *incremental*: the model sees the
// previous summary plus only the transactions recorded since that summary's
// `asOfDate`, never the full ledger. Re-reading a year of history on every
// refresh would cost more each day the user stays, which is the wrong shape for
// a loop that runs daily.
//
// Second, it *interprets but never computes*. Every figure comes from
// `SpendStats`, which `aggregate.ts` derived from the database. The model is
// asked to narrate those numbers, and `findUngroundedFigures` then checks that
// each figure in what it wrote traces back to one — a summary that invents a
// total is rejected rather than persisted.

import { z } from "zod";
import type {
  Money,
  ProfileSummary,
  ProfileSummaryData,
  SpendStats,
  Transaction,
} from "../domain/types";
import { AppError } from "../http/errors";
import { periodDays, type Period } from "./aggregate";
import type { LlmClient, LlmUsage } from "./anthropic";

/** What the agent reads. Assembled by `refreshProfile`, or by a test directly. */
export interface ProfileAgentInput {
  /** The last persisted summary, or `null` on a profile's first refresh. */
  previous: ProfileSummary | null;
  /**
   * Transactions recorded since `previous.asOfDate` — the *only* raw activity
   * the model sees. On a first refresh this is the stats period's transactions,
   * which is a bounded window, not the full history.
   */
  newTransactions: Transaction[];
  /** Deterministic figures for the period being reported on. */
  stats: SpendStats;
  /**
   * Category id → human label. Without it the model sees only UUIDs and cannot
   * name what it is describing, which is most of a spending profile's value.
   */
  categoryLabels: Record<string, string>;
}

export interface ProfileAgentResult {
  summary: ProfileSummaryData;
  narrative: string;
  usage: LlmUsage;
}

const ProfileAgentOutput = z.object({
  habits: z.array(z.string()).max(8),
  trends: z.array(z.string()).max(8),
  notableChanges: z.array(z.string()).max(8),
  narrative: z.string(),
});

/**
 * The stable instruction prefix. Kept free of user data, dates and ids so it is
 * byte-identical across every call and can sit behind the cache breakpoint.
 *
 * It is well under `MIN_CACHEABLE_PREFIX_CHARS`, so the seam will log that
 * caching did not engage — deliberately. Padding to clear the floor would mean
 * sending ~4k tokens of filler on every call to save ~450 real ones, which is
 * more expensive than not caching at all. The floor is worth clearing when a
 * prompt is naturally near it; inflating one to reach it inverts the point.
 *
 * The rule about spelling counts as words is not a style preference: it keeps
 * ordinals ("the top three categories") out of the grounding check, which cannot
 * otherwise tell a harmless "3" from a fabricated one.
 */
export const PROFILE_SYSTEM_PROMPT = `You maintain a rolling financial profile of a personal-spending app's user.

You are given the previous profile summary, the transactions recorded since that summary was written, and a set of deterministically computed statistics for the current period. You return an updated profile.

## What you produce

- **habits**: durable patterns in how this person spends. A habit survives across refreshes — carry forward the ones the new activity still supports, drop the ones it contradicts.
- **trends**: directional movements over time (a category growing, discretionary spend flattening).
- **notableChanges**: what changed since the previous summary specifically. On a first refresh, this is what stands out about the period as a whole.
- **narrative**: two to four sentences addressed to the user, in plain language, describing where their money went and what shifted.

## The grounding rule

Every figure you write must come from the statistics you were given. You may quote a total, an average, a category share or the period-over-period change exactly as computed. You may not estimate, extrapolate, sum, convert, or otherwise derive a number of your own — not even a rounding of one, unless you are rounding a figure that was given to you.

If you want to describe a magnitude the statistics do not contain, describe it in words instead ("a noticeably larger share") rather than inventing a figure.

Write counts and ordinals as words — "the top three categories", not "the top 3 categories". Digits in your output are read as claims about the user's money, and a count written in digits is indistinguishable from a fabricated amount.

## Tone

Factual and specific. No advice, no judgement about whether the spending was wise — a separate step handles suggestions. Do not greet the user or sign off.`;

function formatMoney(money: Money): string {
  return `${(money.amountCents / 100).toFixed(2)} ${money.currency}`;
}

/**
 * The per-request payload: everything volatile, placed after the cache
 * breakpoint. Amounts are rendered in major units because that is how the model
 * is expected to quote them back — handing it cents and asking for currency
 * invites exactly the division the grounding rule forbids.
 */
export function buildProfileInput(input: ProfileAgentInput): string {
  const { previous, newTransactions, stats, categoryLabels } = input;
  // An id with no label falls back to the id: a category seeded after this
  // summary's stats were computed should degrade to something unreadable rather
  // than drop the line and understate the period.
  const labelFor = (categoryId: string) => categoryLabels[categoryId] ?? categoryId;

  const previousBlock = previous
    ? [
        `As of: ${previous.asOfDate}`,
        `Habits: ${previous.summary.habits.join(" | ") || "(none)"}`,
        `Trends: ${previous.summary.trends.join(" | ") || "(none)"}`,
        `Notable changes: ${previous.summary.notableChanges.join(" | ") || "(none)"}`,
        `Narrative: ${previous.narrative}`,
      ].join("\n")
    : "(none — this is the first summary for this user)";

  const transactionLines = newTransactions.length
    ? newTransactions
        .map(
          (tx) =>
            `- ${tx.occurredAt.slice(0, 10)} ${formatMoney(tx.money)} category=${labelFor(tx.categoryId)}` +
            `${tx.merchant ? ` merchant=${tx.merchant}` : ""}${tx.note ? ` note=${tx.note}` : ""}`,
        )
        .join("\n")
    : "(no new transactions since the previous summary)";

  const categoryLines = stats.byCategory
    .map(
      (entry) =>
        `- ${labelFor(entry.categoryId)}: ${formatMoney(entry.total)} (${(entry.share * 100).toFixed(1)}% of period spend)`,
    )
    .join("\n");

  return `# Previous summary
${previousBlock}

# New transactions since the previous summary
${transactionLines}

# Computed statistics for ${stats.periodStart} to ${stats.periodEnd}
Currency: ${stats.currency}
Total spend: ${formatMoney(stats.total)}
Recurring (fixed expenses): ${formatMoney(stats.recurringTotal)}
Discretionary (transactions): ${formatMoney(stats.discretionaryTotal)}
Daily average: ${formatMoney(stats.dailyAverage)}
Weekly average: ${formatMoney(stats.weeklyAverage)}
Change vs. the previous window of equal length: ${formatMoney({ amountCents: stats.momDeltaCents, currency: stats.currency })}

## Spend by category
${categoryLines || "(no categorised spend in this period)"}`;
}

/** Canonical form of a figure, so `1234.5` and `1,234.50` compare equal. */
function normalizeFigure(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * Permit an amount in either denomination. Exported because any agent that
 * *renders* a figure into its prompt has to allow it back: the grounding scan
 * cannot tell a number the model invented from one this code handed it, so
 * whatever a payload shows must be added here or a faithful quote is rejected.
 */
export function addMoneyFigures(allowed: Set<string>, money: Money): void {
  const cents = money.amountCents;
  const major = cents / 100;
  // Both denominations, since the model may quote either, and both the rounded
  // and truncated major unit, since "about 1,234" is a legitimate rendering of
  // 1234.56 rather than a new number.
  for (const value of [cents, major, Math.round(major), Math.trunc(major)]) {
    allowed.add(normalizeFigure(value));
    allowed.add(normalizeFigure(Math.abs(value)));
  }
}

/**
 * Permit a 0..1 share as the percentage a payload renders it as, at each
 * rounding a model might reasonably quote it back with.
 */
export function addShareFigures(allowed: Set<string>, share: number): void {
  const pct = share * 100;
  allowed.add(normalizeFigure(pct));
  allowed.add(normalizeFigure(Math.round(pct)));
  allowed.add(normalizeFigure(Math.round(pct * 10) / 10));
}

/**
 * Every number the model is permitted to write, derived from the same stats it
 * was shown. Counts are included because "the top five categories" is a claim
 * about the data, and it happens to be a true one when five is how many there
 * are — an ordinal that matches nothing in the stats is still a fabrication.
 */
export function allowedFigures(stats: SpendStats, newTransactions: Transaction[]): Set<string> {
  const allowed = new Set<string>();

  // The individual amounts are shown to the model in the transaction block, and
  // they come from the user's own ledger — quoting "a 15.00 EUR lunch" is a
  // reading of the data, not a fabrication. Forbidding them would fail a refresh
  // over a figure this code handed the model itself.
  for (const transaction of newTransactions) {
    addMoneyFigures(allowed, transaction.money);
  }

  for (const money of [
    stats.total,
    stats.recurringTotal,
    stats.discretionaryTotal,
    stats.dailyAverage,
    stats.weeklyAverage,
  ]) {
    addMoneyFigures(allowed, money);
  }
  addMoneyFigures(allowed, { amountCents: stats.momDeltaCents, currency: stats.currency });

  for (const entry of stats.byCategory) {
    addMoneyFigures(allowed, entry.total);
    addShareFigures(allowed, entry.share);
  }

  const period: Period = { start: stats.periodStart, end: stats.periodEnd };
  for (const count of [
    stats.byCategory.length,
    stats.topCategories.length,
    newTransactions.length,
    periodDays(period),
  ]) {
    allowed.add(normalizeFigure(count));
  }

  // Years only, for prose like "July 2026" — a full ISO date is stripped before
  // scanning, so it needs nothing here. The month and day parts are deliberately
  // *not* allowed: adding them would license a bare "7" or "19" anywhere in the
  // narrative, which is exactly the fabricated-count case this is meant to catch.
  for (const date of [stats.periodStart, stats.periodEnd]) {
    allowed.add(normalizeFigure(Number(date.slice(0, 4))));
  }

  return allowed;
}

// A number, with optional thousands separators, decimal part and percent sign.
const FIGURE_PATTERN = /\d[\d,]*(?:\.\d+)?%?/g;

/**
 * Figures in `text` that trace back to nothing in `stats`. Empty means grounded.
 *
 * ISO dates are removed before scanning rather than allow-listed part by part:
 * `2026-07-19` would otherwise contribute a bare `7` to the permitted set and
 * quietly license an unrelated "7" elsewhere in the narrative.
 *
 * UUIDs are removed for the opposite reason. Categories are labelled now, so the
 * model has no cause to quote an id — but a stray one would otherwise be read as
 * a run of enormous fabricated figures and fail the refresh over the code's own
 * identifier rather than over anything the model claimed about money.
 */
export function findUngroundedFigures(text: string, allowed: Set<string>): string[] {
  const scannable = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
    .replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const ungrounded: string[] = [];

  for (const match of scannable.matchAll(FIGURE_PATTERN)) {
    const token = match[0];
    const value = Number(token.replace(/,/g, "").replace(/%$/, ""));
    if (Number.isNaN(value)) continue;
    if (!allowed.has(normalizeFigure(value))) ungrounded.push(token);
  }

  return ungrounded;
}

/** Everything the model wrote, as one string — the grounding check's subject. */
function narratedText(output: z.infer<typeof ProfileAgentOutput>): string {
  return [...output.habits, ...output.trends, ...output.notableChanges, output.narrative].join(
    "\n",
  );
}

/**
 * Run one profiling pass.
 *
 * A grounding violation fails the refresh instead of triggering a corrective
 * retry: a second call is a second bill, and a model that fabricated a figure
 * once has already shown the prompt did not hold it. The caller sees a 502 and
 * the previous summary stays in place, which is the safer of the two states —
 * a stale profile is recoverable, a plausible wrong number shown as fact is not.
 */
export async function runProfileAgent(
  llm: LlmClient,
  input: ProfileAgentInput,
): Promise<ProfileAgentResult> {
  const { data, usage } = await llm.complete({
    system: PROFILE_SYSTEM_PROMPT,
    input: buildProfileInput(input),
    schema: ProfileAgentOutput,
    schemaName: "profile_summary",
  });

  const ungrounded = findUngroundedFigures(
    narratedText(data),
    allowedFigures(input.stats, input.newTransactions),
  );
  if (ungrounded.length > 0) {
    throw new AppError(502, "LLM_UNGROUNDED", "the model reported figures absent from the stats", {
      cause: new Error(`ungrounded figures: ${ungrounded.join(", ")}`),
    });
  }

  return {
    summary: { habits: data.habits, trends: data.trends, notableChanges: data.notableChanges },
    narrative: data.narrative,
    usage,
  };
}
