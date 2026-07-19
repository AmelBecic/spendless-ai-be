// Shared domain contracts for the SpendLess backend.
//
// Money is always integer minor units (cents) plus an ISO-4217 currency code —
// never a float, never a bare number. Everything that carries an amount uses
// `Money` so the "no floats, no cross-currency arithmetic" rule holds end to end.

/** An amount of money as integer minor units plus its currency. */
export interface Money {
  /** Integer number of minor units (e.g. cents). Never fractional. */
  amountCents: number;
  /** ISO-4217 currency code, e.g. "EUR", "USD". */
  currency: string;
}

/** How often a fixed expense recurs. */
export type Cadence = "weekly" | "monthly" | "yearly";

/** A spend category. `key` is the stable machine identifier; `label` is for display. */
export interface Category {
  id: string;
  key: string;
  label: string;
}

/** A user's own settings. `userId` is the Supabase `auth.users.id`. */
export interface UserProfile {
  userId: string;
  /** The currency every amount of this user's is denominated in. */
  currency: string;
  /** IANA timezone, e.g. "Europe/Sarajevo" — the day boundary stats are cut on. */
  timezone: string;
  /** Declared monthly income, in the profile's currency. Absent until the user sets it. */
  monthlyIncome?: Money;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/** A recurring commitment (rent, subscriptions, …). */
export interface FixedExpense {
  id: string;
  userId: string;
  label: string;
  categoryId: string;
  money: Money;
  cadence: Cadence;
  active: boolean;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** A single day-to-day spend event — the primary stream the profile is built from. */
export interface Transaction {
  id: string;
  userId: string;
  money: Money;
  categoryId: string;
  merchant?: string;
  note?: string;
  /** ISO-8601 timestamp of when the spend happened. */
  occurredAt: string;
  /** ISO-8601 timestamp of when the row was recorded. */
  createdAt: string;
}

/** A category's contribution to total spend over a period. */
export interface CategoryTotal {
  categoryId: string;
  total: Money;
  /** Fraction of the period's total spend, 0..1. */
  share: number;
}

/**
 * Deterministically computed spend statistics for a user over a period.
 * Produced by the aggregation layer (SLAI-11) — the LLM reads these but never
 * computes them.
 */
export interface SpendStats {
  /** ISO-8601 date (inclusive). */
  periodStart: string;
  /** ISO-8601 date (inclusive). */
  periodEnd: string;
  currency: string;
  total: Money;
  byCategory: CategoryTotal[];
  topCategories: CategoryTotal[];
  /** Fixed-expense spend attributed to the period. */
  recurringTotal: Money;
  /** Transaction (discretionary) spend in the period. */
  discretionaryTotal: Money;
  dailyAverage: Money;
  weeklyAverage: Money;
  /**
   * Signed change in total spend against the window of equal length ending the
   * day before this one starts, in cents.
   *
   * Read the comparison literally: it is a *trailing* window, not the same dates
   * of the previous calendar month. Month-to-date on 19 July is therefore
   * compared against 12–30 June, not 1–19 June. Equal length is what keeps the
   * figure meaningful for the arbitrary `from`/`to` the endpoint accepts — a
   * 10-day window has no "previous month" to compare against, and against a
   * fixed calendar month it would always look cheaper.
   */
  momDeltaCents: number;
}

/** Structured payload of an AI-maintained profile summary. */
export interface ProfileSummaryData {
  habits: string[];
  trends: string[];
  notableChanges: string[];
}

/** A point-in-time, AI-maintained summary of a user's financial profile. */
export interface ProfileSummary {
  id: string;
  userId: string;
  /** ISO-8601 date this summary describes. */
  asOfDate: string;
  summary: ProfileSummaryData;
  narrative: string;
  /** Model id that produced it, e.g. "claude-opus-4-8". */
  model: string;
  createdAt: string;
}

export type SuggestionStatus = "new" | "dismissed" | "applied";

/** A grounded, cited savings suggestion. */
export interface Suggestion {
  id: string;
  userId: string;
  asOfDate: string;
  text: string;
  categoryId?: string;
  /** Estimated monthly saving if applied — computed deterministically, not hallucinated. */
  estMonthlySavings: Money;
  rationale: string;
  /** Ids/keys of the stats or transactions this suggestion is grounded in. */
  sourceRefs: string[];
  status: SuggestionStatus;
  createdAt: string;
}
