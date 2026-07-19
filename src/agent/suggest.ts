// The suggestion agent.
//
// The division of labour is the whole point of this file. The model identifies
// *which* opportunity is worth taking and how hard to push it; this module
// computes what that opportunity is worth. No figure a user is shown is ever
// read out of a completion — the model never emits an amount at all, and the
// schema below gives it no field to put one in.
//
// That is stricter than the profiling agent, which may quote a computed stat
// back. A narrative that quotes a total is reporting; a suggestion that quotes a
// saving is *predicting*, and a prediction the model made up is indistinguishable
// from one the ledger supports. So the lever it picks is qualitative
// ("moderate"), the rates live here as constants, and the arithmetic is
// `aggregate.ts`'s.

import { z } from "zod";
import type {
  CategoryTotal,
  FixedExpense,
  Money,
  ProfileSummary,
  SpendStats,
} from "../domain/types";
import { INT4_MAX } from "../domain/money";
import { monthlyEquivalentCents, monthlyRateCents, periodDays, type Period } from "./aggregate";
import type { LlmClient, LlmUsage } from "./anthropic";
import { allowedFigures, findUngroundedFigures } from "./profile";

/** What kind of lever a suggestion pulls. */
export type SuggestionKind = "trim_category" | "cancel_recurring";

/** How hard the model thinks this opportunity can be pushed. */
export type TrimLever = "modest" | "moderate" | "aggressive";

/**
 * What each lever is worth, as a fraction of the category's monthly rate.
 *
 * These are code constants precisely so the model cannot choose them. It grades
 * an opportunity on a three-point scale it cannot game into a bigger number, and
 * the scale's meaning is fixed here where it can be reviewed and tested.
 */
export const TRIM_RATES: Record<TrimLever, number> = {
  modest: 0.1,
  moderate: 0.2,
  aggressive: 0.3,
};

/** Ceiling on one pass's output — a suggestion feed is read, not scrolled. */
export const MAX_SUGGESTIONS = 5;

/** What the agent reads. Assembled by `refreshSuggestions`, or by a test directly. */
export interface SuggestionAgentInput {
  /** The latest profile summary, or `null` if the user has never been profiled. */
  profile: ProfileSummary | null;
  /** Deterministic figures for the period being advised on. */
  stats: SpendStats;
  /**
   * Per-category spend from transactions alone — the base a trim is priced
   * against. Deliberately not `stats.byCategory`, which folds in prorated
   * commitments the user cannot trim by spending differently.
   */
  discretionaryByCategory: CategoryTotal[];
  /**
   * The user's fixed expenses. Only active ones in the stats currency are
   * offered to the model, since those are the only ones a cancellation could
   * honestly be priced against.
   */
  fixedExpenses: FixedExpense[];
  /** Category id → human label, so the model names what it is describing. */
  categoryLabels: Record<string, string>;
}

/** A suggestion whose figure this module computed. */
export interface GroundedSuggestion {
  kind: SuggestionKind;
  text: string;
  rationale: string;
  /** Set for both kinds — a recurring expense has a category too. */
  categoryId: string;
  /** Computed here from `stats`; never from the model. */
  estMonthlySavings: Money;
  /** Stable keys naming the stat/category the figure rests on. Built in code. */
  sourceRefs: string[];
}

/** Why a proposal the model made did not survive validation. */
export type DropReason =
  | "unknown-target"
  | "duplicate-target"
  | "currency-mismatch"
  | "no-saving"
  | "not-representable"
  | "ungrounded-figure";

export interface DroppedSuggestion {
  kind: SuggestionKind;
  targetId: string;
  reason: DropReason;
}

export interface SuggestionAgentResult {
  suggestions: GroundedSuggestion[];
  /**
   * Proposals that were rejected, surfaced rather than swallowed. A model that
   * starts citing categories the user does not have is a prompt regression, and
   * it is invisible if the only symptom is a shorter list.
   */
  dropped: DroppedSuggestion[];
  usage: LlmUsage;
}

/**
 * What the model may return. Note what is *absent*: there is no amount, no
 * percentage and no currency field. The schema is the enforcement — a model
 * inclined to volunteer "saves €40/month" has nowhere to put it.
 */
const SuggestionAgentOutput = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z.enum(["trim_category", "cancel_recurring"]),
        /** A category id for `trim_category`, a fixed-expense id for `cancel_recurring`. */
        targetId: z.string(),
        lever: z.enum(["modest", "moderate", "aggressive"]),
        text: z.string(),
        rationale: z.string(),
      }),
    )
    .max(MAX_SUGGESTIONS),
});

/**
 * The stable instruction prefix — no user data, no dates, no ids, so it is
 * byte-identical across calls. Like the profiling prompt it sits under
 * `MIN_CACHEABLE_PREFIX_CHARS` and the seam will say so; padding it to reach the
 * floor would cost more than the caching saves.
 */
export const SUGGEST_SYSTEM_PROMPT = `You find realistic ways for a personal-spending app's user to save money.

You are given the user's profile summary, deterministically computed statistics for the current period, their spend by category, and their active recurring commitments. You return a short list of suggestions.

## What you produce

Each suggestion names one opportunity:

- **trim_category**: the user could spend less in a category they are actively spending in. \`targetId\` is that category's id.
- **cancel_recurring**: a recurring commitment looks droppable. \`targetId\` is that commitment's id.

Alongside it:

- **lever**: how much room you think there is — \`modest\`, \`moderate\` or \`aggressive\`. This is a judgement about how easily this spending could be reduced, not a number. Reserve \`aggressive\` for spending that is clearly discretionary and clearly elevated. (For \`cancel_recurring\` the lever is recorded but not used: cancelling is all-or-nothing.)
- **text**: one sentence, addressed to the user, saying what to do.
- **rationale**: one or two sentences on why this is the opportunity, referring to what you were shown.

## What you must not do

**Never write an amount of money, a percentage, or any other figure.** You are not being asked what the saving is worth — that is computed from the statistics after you answer, and a figure you supply would be discarded at best and wrong at worst. Describe magnitudes in words: "your largest discretionary category", "well above the rest", "a small recurring charge".

Write counts and ordinals as words — "the top three categories", not "the top 3 categories".

**Only ever cite an id you were given.** A suggestion naming a category or commitment that is not in the lists below is dropped, and the user gets fewer suggestions as a result.

Do not suggest trimming a category with no spending in this period. Do not propose the same target twice — pick the single best framing of it.

## Tone

Concrete and respectful. The user chose this spending; you are pointing out room, not scolding. No greeting, no sign-off. Fewer, better suggestions beat filling the list.`;

function formatMoney(money: Money): string {
  return `${(money.amountCents / 100).toFixed(2)} ${money.currency}`;
}

/**
 * The commitments a cancellation may be priced against: active, and denominated
 * in the currency every other figure is in. A foreign-currency expense is
 * withheld rather than converted — there is no rate in this system, and a
 * suggestion is not the place to invent one.
 */
export function suggestibleExpenses(
  fixedExpenses: FixedExpense[],
  currency: string,
): FixedExpense[] {
  return fixedExpenses.filter((expense) => expense.active && expense.money.currency === currency);
}

/** The per-request payload: everything volatile, after the cache breakpoint. */
export function buildSuggestionInput(input: SuggestionAgentInput): string {
  const { profile, stats, discretionaryByCategory, fixedExpenses, categoryLabels } = input;
  const labelFor = (categoryId: string) => categoryLabels[categoryId] ?? categoryId;

  const profileBlock = profile
    ? [
        `Habits: ${profile.summary.habits.join(" | ") || "(none)"}`,
        `Trends: ${profile.summary.trends.join(" | ") || "(none)"}`,
        `Notable changes: ${profile.summary.notableChanges.join(" | ") || "(none)"}`,
        `Narrative: ${profile.narrative}`,
      ].join("\n")
    : "(none — this user has not been profiled yet)";

  // Ids are shown because the model has to cite one back. The grounding scan
  // strips uuids before it looks for figures, so they cost nothing there.
  //
  // The discretionary breakdown is what is offered, not `stats.byCategory`: a
  // trim is only ever priced against spending the user could choose to change,
  // so showing them a category swollen by rent would invite a suggestion this
  // code then prices far lower than the model had in mind.
  const categoryLines = discretionaryByCategory
    .map(
      (entry) =>
        `- ${labelFor(entry.categoryId)} [id: ${entry.categoryId}]: ${formatMoney(entry.total)}` +
        ` (${(entry.share * 100).toFixed(1)}% of discretionary spend)`,
    )
    .join("\n");

  const expenseLines = suggestibleExpenses(fixedExpenses, stats.currency)
    .map(
      (expense) =>
        `- ${expense.label} [id: ${expense.id}]: ${formatMoney(expense.money)} ${expense.cadence}` +
        `, category ${labelFor(expense.categoryId)}`,
    )
    .join("\n");

  return `# Profile summary
${profileBlock}

# Computed statistics for ${stats.periodStart} to ${stats.periodEnd}
Currency: ${stats.currency}
Total spend: ${formatMoney(stats.total)}
Recurring (fixed expenses): ${formatMoney(stats.recurringTotal)}
Discretionary (transactions): ${formatMoney(stats.discretionaryTotal)}
Daily average: ${formatMoney(stats.dailyAverage)}

## Discretionary spend by category (what a trim can be priced against)
${categoryLines || "(no discretionary spend in this period)"}

## Active recurring commitments
${expenseLines || "(none)"}`;
}

/**
 * Every source ref the code is willing to emit for this input.
 *
 * Exported so the grounding contract is assertable from the outside: a test can
 * check that every ref on every returned suggestion is a member of this set,
 * which is what "cites nothing that does not exist" means operationally.
 */
export function knownSourceRefs(
  stats: SpendStats,
  discretionaryByCategory: CategoryTotal[],
  fixedExpenses: FixedExpense[],
): Set<string> {
  const refs = new Set<string>(["stat:discretionaryTotal", "stat:recurringTotal"]);
  for (const entry of discretionaryByCategory) refs.add(`category:${entry.categoryId}`);
  for (const expense of suggestibleExpenses(fixedExpenses, stats.currency)) {
    refs.add(`fixedExpense:${expense.id}`);
  }
  return refs;
}

/** One validated proposal, or the reason it was dropped. */
type Priced = { ok: true; suggestion: GroundedSuggestion } | { ok: false; reason: DropReason };

/**
 * Reject a figure the column cannot hold.
 *
 * `estMonthlySavingsCents` is a Prisma `Int`, i.e. int4, and a monthly rate is
 * scaled *up* from the period observed so far — on the first of the month that
 * multiplies by about thirty. A large enough ledger therefore produces a saving
 * past the bound, which would fail at the insert as an opaque 500 rather than as
 * anything the caller could act on. Dropping it loses one suggestion; clamping
 * would quote a number the ledger does not support, which is the one thing this
 * agent exists not to do.
 */
function representable(amountCents: number): boolean {
  return Number.isSafeInteger(amountCents) && amountCents <= INT4_MAX;
}

/**
 * Price a `trim_category` proposal: the category's spend restated as a monthly
 * rate, times the lever's fixed fraction.
 */
function priceTrim(
  stats: SpendStats,
  discretionary: CategoryTotal[],
  period: Period,
  categoryId: string,
  lever: TrimLever,
  text: string,
  rationale: string,
): Priced {
  const entry = discretionary.find((candidate) => candidate.categoryId === categoryId);
  if (!entry) return { ok: false, reason: "unknown-target" };
  // Defensive: the breakdown is denominated in the ledger currency, so this
  // cannot currently differ. It is checked anyway because the alternative to a
  // dropped suggestion is a figure labelled with the wrong currency.
  if (entry.total.currency !== stats.currency) {
    return { ok: false, reason: "currency-mismatch" };
  }

  const monthly = monthlyRateCents(entry.total.amountCents, periodDays(period));
  const amountCents = Math.round(monthly * TRIM_RATES[lever]);
  // A category whose monthly rate rounds to nothing worth saving. Showing "save
  // 0.00" would read as a bug, and it very nearly is one.
  if (amountCents <= 0) return { ok: false, reason: "no-saving" };
  if (!representable(amountCents)) return { ok: false, reason: "not-representable" };

  return {
    ok: true,
    suggestion: {
      kind: "trim_category",
      text,
      rationale,
      categoryId,
      estMonthlySavings: { amountCents, currency: stats.currency },
      sourceRefs: [`category:${categoryId}`, "stat:discretionaryTotal"],
    },
  };
}

/** Price a `cancel_recurring` proposal: the whole commitment, per average month. */
function priceCancel(
  stats: SpendStats,
  fixedExpenses: FixedExpense[],
  expenseId: string,
  text: string,
  rationale: string,
): Priced {
  const expense = suggestibleExpenses(fixedExpenses, stats.currency).find(
    (candidate) => candidate.id === expenseId,
  );
  if (!expense) {
    // An id that exists but is inactive or foreign-currency was never shown to
    // the model, so it is as unknown as one that does not exist at all.
    const exists = fixedExpenses.some((candidate) => candidate.id === expenseId);
    return { ok: false, reason: exists ? "currency-mismatch" : "unknown-target" };
  }

  const amountCents = monthlyEquivalentCents(expense);
  if (amountCents <= 0) return { ok: false, reason: "no-saving" };
  // A weekly commitment is scaled up by more than four to reach a month, so this
  // is reachable here too, not only on the trim path.
  if (!representable(amountCents)) return { ok: false, reason: "not-representable" };

  return {
    ok: true,
    suggestion: {
      kind: "cancel_recurring",
      text,
      rationale,
      categoryId: expense.categoryId,
      estMonthlySavings: { amountCents, currency: stats.currency },
      sourceRefs: [`fixedExpense:${expense.id}`, "stat:recurringTotal"],
    },
  };
}

/**
 * Run one suggestion pass.
 *
 * Unlike `runProfileAgent`, a bad item is dropped rather than failing the call. A
 * profile is one narrative, so a single fabricated figure poisons all of it; a
 * suggestion list is a set of independent claims, and discarding the one that
 * cites a category the user does not have leaves the rest just as true. The
 * dropped items are returned so the caller can log them.
 */
export async function runSuggestionAgent(
  llm: LlmClient,
  input: SuggestionAgentInput,
): Promise<SuggestionAgentResult> {
  const { stats, discretionaryByCategory, fixedExpenses } = input;
  const { data, usage } = await llm.complete({
    system: SUGGEST_SYSTEM_PROMPT,
    input: buildSuggestionInput(input),
    schema: SuggestionAgentOutput,
    schemaName: "savings_suggestions",
  });

  const period: Period = { start: stats.periodStart, end: stats.periodEnd };
  // No transactions are shown to this agent, so only the stats ground its prose.
  const allowed = allowedFigures(stats, []);

  const suggestions: GroundedSuggestion[] = [];
  const dropped: DroppedSuggestion[] = [];
  const seen = new Set<string>();

  for (const proposal of data.suggestions) {
    const { kind, targetId, lever, text, rationale } = proposal;
    const reject = (reason: DropReason): void => {
      dropped.push({ kind, targetId, reason });
    };

    // Two suggestions against one target are two bites of the same saving; the
    // totals would double-count if a client ever summed the feed.
    if (seen.has(targetId)) {
      reject("duplicate-target");
      continue;
    }

    // The prompt forbids figures outright, so anything numeric here is either a
    // fabricated amount or the model ignoring an instruction — neither belongs
    // in front of a user next to a number this code vouched for.
    if (findUngroundedFigures(`${text}\n${rationale}`, allowed).length > 0) {
      reject("ungrounded-figure");
      continue;
    }

    const priced =
      kind === "trim_category"
        ? priceTrim(stats, discretionaryByCategory, period, targetId, lever, text, rationale)
        : priceCancel(stats, fixedExpenses, targetId, text, rationale);

    if (!priced.ok) {
      reject(priced.reason);
      continue;
    }
    seen.add(targetId);
    suggestions.push(priced.suggestion);
  }

  return { suggestions, dropped, usage };
}
