// The AI-maintained profile summaries, scoped to their owner.
//
// One row per user per day: the writer upserts on the `(userId, asOfDate)`
// unique key, so refreshing twice in a day rewrites that day's summary rather
// than accumulating near-duplicates. `latest` is the incremental loop's anchor —
// the profiling agent reads it to learn how far it has already processed.

import type { Prisma, PrismaClient, ProfileSummary as ProfileSummaryRow } from "@prisma/client";
import type { ProfileSummary, ProfileSummaryData } from "../domain/types";
import { toStringArray } from "./shared";

export interface UpsertProfileSummaryInput {
  /** The day the underlying stats were computed for. */
  asOfDate: Date;
  summary: ProfileSummaryData;
  narrative: string;
  /** The model that produced it — recorded per row, not assumed globally. */
  model: string;
}

export interface ProfileSummariesRepository {
  /**
   * The caller's most recent summary, or `null` on a profile that has never been
   * refreshed. A single row rather than a page: the loop only ever needs the
   * newest one, so there is no unbounded read here even though the table grows
   * by a row per active day. Reading the history needs a paged method that does
   * not exist yet — add one when something needs it, rather than an unpaged
   * `list` that quietly returns a year of rows.
   */
  latest(userId: string): Promise<ProfileSummary | null>;
  upsert(userId: string, input: UpsertProfileSummaryInput): Promise<ProfileSummary>;
}

/**
 * Read the Json `summary` column back as the domain type. A column written by an
 * earlier schema version — or by hand — is not trusted to have the right shape,
 * so each field degrades to an empty list rather than handing a `string[]` that
 * turns out to hold something else.
 */
function toSummaryData(value: ProfileSummaryRow["summary"]): ProfileSummaryData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { habits: [], trends: [], notableChanges: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    habits: toStringArray(record.habits ?? []),
    trends: toStringArray(record.trends ?? []),
    notableChanges: toStringArray(record.notableChanges ?? []),
  };
}

/**
 * The domain type as a Json column value. Written out field by field rather than
 * cast: an interface has no index signature, so Prisma will not take it directly,
 * and a cast would also wave through whatever a future field holds.
 */
function toJson(summary: ProfileSummaryData): Prisma.InputJsonObject {
  return {
    habits: summary.habits,
    trends: summary.trends,
    notableChanges: summary.notableChanges,
  };
}

function toDomain(row: ProfileSummaryRow): ProfileSummary {
  return {
    id: row.id,
    userId: row.userId,
    // A `date` column comes back as UTC midnight; the date part is the value.
    asOfDate: row.asOfDate.toISOString().slice(0, 10),
    summary: toSummaryData(row.summary),
    narrative: row.narrative,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createProfileSummariesRepository(
  prisma: Pick<PrismaClient, "profileSummary">,
): ProfileSummariesRepository {
  return {
    async latest(userId) {
      const row = await prisma.profileSummary.findFirst({
        where: { userId },
        // `createdAt` breaks a tie within a day; id makes the order total, so
        // "latest" is a single well-defined row even after a same-day rewrite.
        orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      });
      return row ? toDomain(row) : null;
    },

    async upsert(userId, input) {
      const row = await prisma.profileSummary.upsert({
        where: { userId_asOfDate: { userId, asOfDate: input.asOfDate } },
        // Picked, not spread — see the note in transactions.ts.
        create: {
          userId,
          asOfDate: input.asOfDate,
          summary: toJson(input.summary),
          narrative: input.narrative,
          model: input.model,
        },
        // `userId` and `asOfDate` are the key this matched on; rewriting them
        // would move the row to another day, or another user.
        update: {
          summary: toJson(input.summary),
          narrative: input.narrative,
          model: input.model,
        },
      });
      return toDomain(row);
    },
  };
}
