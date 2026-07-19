// GET /stats — the caller's deterministic spend statistics for a period.
//
// The handler does no arithmetic. It resolves the window, gathers the ledger
// through the repository seam, and hands both to `aggregate`; the reading of the
// clock lives here rather than in the aggregation, which stays a pure function
// of the period it is given.
//
// Amounts follow the Money rules, so a ledger mixing currencies leaves as a 409
// rather than a total that added dollars to euros.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SpendStats } from "../domain/types";
import { MixedCurrencyError } from "../domain/money";
import { aggregate, periodDays, type Period } from "../agent/aggregate";
import { LedgerTooLargeError, loadLedger, type LedgerDeps } from "../agent/stats";
import { requireUser } from "../auth/plugin";
import { AppError, ValidationError } from "../http/errors";
import { parseOrThrow } from "../http/validation";
import { isoDate } from "./fields";

export type StatsDeps = LedgerDeps;

export interface StatsResponse {
  stats: SpendStats;
}

const StatsQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  // Both are `YYYY-MM-DD` by the time this runs, so a string compare is a date
  // compare.
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ["from"],
    message: "must not be after `to`",
  });

/**
 * Fill in whichever bound the caller left out, defaulting to month-to-date in
 * UTC.
 *
 * Each branch is chosen so the window can never come out inverted — a period
 * whose end precedes its start is a `RangeError` out of `periodDays`, i.e. a 500
 * on an otherwise valid request. With only `to` given, the start is anchored to
 * *that* date's month rather than today's; with only a future `from`, the end
 * follows it instead of staying at today.
 */
function resolvePeriod(query: { from?: string; to?: string }, now: Date): Period {
  const today = now.toISOString().slice(0, 10);
  const end = query.to ?? (query.from && query.from > today ? query.from : today);
  const start = query.from ?? `${end.slice(0, 7)}-01`;
  return { start, end };
}

/**
 * The widest window /stats will report on — a year, leap year included, which
 * covers the broadest span the surface is meant for.
 *
 * Checked against the *resolved* period rather than the raw query, since a lone
 * `?from=1900-01-01` widens the window just as effectively as naming both ends.
 * Rejecting here matters because the cost is paid before the ledger's own cap
 * can trip: an unbounded span sends `loadLedger` on two sequential cursor walks
 * (the period, plus the equal-length one behind it) that do the full amount of
 * database work and then throw it away. A 400 up front costs one comparison.
 */
export const MAX_PERIOD_DAYS = 366;

function assertPeriodWithinLimit(period: Period): void {
  if (periodDays(period) > MAX_PERIOD_DAYS) {
    throw new ValidationError([
      { path: "from", message: `period must span at most ${MAX_PERIOD_DAYS} days` },
    ]);
  }
}

export function registerStatsRoute(app: FastifyInstance, deps: StatsDeps): void {
  app.get("/stats", { preHandler: app.authenticate }, async (req): Promise<StatsResponse> => {
    const user = requireUser(req);
    const query = parseOrThrow(StatsQuery, req.query, "invalid query parameters");
    const period = resolvePeriod(query, new Date());
    assertPeriodWithinLimit(period);

    try {
      const ledger = await loadLedger(deps, user.id, period);
      if (!ledger) throw new AppError(404, "NOT_FOUND", "profile not found");
      return { stats: aggregate(period, ledger) };
    } catch (err) {
      if (err instanceof MixedCurrencyError) {
        // The request is well-formed; the stored data is not. Any number this
        // could return would be one currency's total wearing another's label,
        // so it reports the conflict instead.
        throw new AppError(409, "MIXED_CURRENCY", err.message, { cause: err });
      }
      if (err instanceof LedgerTooLargeError) {
        throw new AppError(422, "PERIOD_TOO_LARGE", err.message, { cause: err });
      }
      throw err;
    }
  });
}
