// Request-field schemas shared by the resource routes. These encode storage
// bounds and normalisation rules that must not drift between endpoints: an
// amount the fixed-expenses route rejects has to be rejected by /transactions
// too, or the same value is a 400 on one table and a 500 on the other.

import { z } from "zod";
import type { CategoriesRepository } from "../repositories/categories";
import { ValidationError } from "../http/errors";

// Integer cents only: `.int()` rejects a float outright rather than rounding it,
// so an amount can never lose precision on the way in.
//
// The upper bound is the storage bound, not a product rule: `amountCents` is a
// Prisma `Int`, i.e. Postgres int4. Without it, 2_147_483_648 passes validation
// and overflows at the database — the 500 that the categoryId check exists to
// avoid, in a different guise. Verified against the column: 2_147_483_647
// stores, one more raises.
export const INT4_MAX = 2_147_483_647;

export const amountCents = z
  .number()
  .int("must be an integer number of cents")
  .positive("must be greater than 0")
  .max(INT4_MAX, "is too large");

// Stored as written, so normalise case here — "eur" and "EUR" must not become
// two currencies that money arithmetic then refuses to combine.
export const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO-4217 code");

// `guid`, not `uuid`: the shape check is what keeps an unparseable value from
// reaching a uuid column (Postgres would raise P2023), but the *version* nibble
// is not ours to assert — these ids are minted by the database, and pinning v4
// here would turn a future v7 id into "malformed input". Probed: z.uuid()
// rejects a non-v4 uuid, z.guid() accepts any uuid-shaped string.
export const categoryId = z.guid("must be a category id");

// A calendar date (`2026-07-18`) or a full timestamp. The 4-digit year in the
// pattern is doing real work: it caps the value at 9999-12-31, comfortably
// inside Postgres's timestamp range, so an absurd year cannot reach the column.
const ISO_DATE_OR_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * True when `value` names a date that exists and a time the engine can read.
 *
 * The calendar part is checked arithmetically rather than by inspecting what
 * `Date` produced, because both halves of the obvious approach mislead. A
 * `Date.parse` NaN check alone is too weak: a day out of any month's range
 * (`2026-07-32`, `2026-13-01`) does yield NaN, but a day merely wrong for *its*
 * month does not — `2026-02-31` silently rolls forward to 2026-03-03, filing a
 * typo'd spend in the wrong month for the stats layer to later report as fact.
 * Comparing the parsed date's components back is too strict: per the spec a
 * timestamp with no `Z` or offset is read as *local* time, so `…T00:30:00` in a
 * positive-offset zone lands on the previous UTC day and would be rejected as
 * unreal. Counting the days in the month sidesteps both. (Probed, not assumed.)
 */
function isRealCalendarDate(value: string): boolean {
  const match = ISO_DATE_OR_DATETIME.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the following month is the last day of this one.
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return false;
  // The date is real; the time-of-day, if any, still has to parse.
  return !Number.isNaN(Date.parse(value));
}

export const timestamp = z
  .string()
  .trim()
  .regex(ISO_DATE_OR_DATETIME, "must be an ISO-8601 date or date-time")
  .refine(isRealCalendarDate, "is not a real date")
  .transform((value) => new Date(value));

/**
 * Free text a client may send empty to mean "none". Trimmed before the length
 * check (so trailing whitespace cannot fail an otherwise-valid value) and
 * stored as NULL rather than "", to keep "absent" a single representation.
 */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `must be at most ${max} characters`)
    .transform((value) => (value === "" ? null : value));
}

/**
 * Confirm the category exists, as a 400 on `categoryId` rather than the 500 the
 * foreign key would otherwise raise. The category set is bounded reference data
 * (see repositories/categories.ts), so listing it is a cheap read of a small
 * table, not a scan that grows with use.
 */
export async function assertCategoryExists(
  categories: CategoriesRepository,
  id: string,
): Promise<void> {
  const all = await categories.list();
  if (!all.some((category) => category.id === id)) {
    throw new ValidationError([{ path: "categoryId", message: "no such category" }]);
  }
}
