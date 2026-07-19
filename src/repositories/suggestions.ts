// Grounded savings suggestions, scoped to their owner.
//
// The agent writes these; the user reads them and flips their status. Both sides
// go through here, so a suggestion computed for one user can never be listed or
// dismissed by another.

import type { Prisma, PrismaClient, Suggestion as SuggestionRow } from "@prisma/client";
import type { Suggestion, SuggestionStatus } from "../domain/types";
import {
  isUnparseableUuid,
  nullIfNotFound,
  pageSize,
  toPage,
  toStringArray,
  type Page,
} from "./shared";

export interface CreateSuggestionInput {
  /** The day the underlying stats were computed for. */
  asOfDate: Date;
  text: string;
  categoryId?: string | null;
  estMonthlySavingsCents: number;
  currency: string;
  rationale: string;
  /** Ids/keys of the stats or transactions this suggestion is grounded in. */
  sourceRefs: string[];
}

export interface ListSuggestionsOptions {
  asOfDate?: Date;
  status?: SuggestionStatus;
  /** Clamped to 1..200; defaults to 50. */
  limit?: number;
  /** Id of the last row of the previous page. */
  cursor?: string;
}

/**
 * Newest day first, then the biggest saving within that day; id breaks the
 * remaining ties so the order is total, which is what makes the cursor stable.
 *
 * Ranked by value rather than by `createdAt` because a refresh writes a whole
 * day's set in one pass: those rows share a timestamp to the millisecond, so
 * insertion order sorts them arbitrarily and the top of a user's feed would be
 * whichever row happened to win the tiebreak.
 */
const LIST_ORDER: Prisma.SuggestionOrderByWithRelationInput[] = [
  { asOfDate: "desc" },
  { estMonthlySavingsCents: "desc" },
  { id: "asc" },
];

export interface SuggestionsRepository {
  /**
   * Paged: the agent writes suggestions per `asOfDate`, so a user's history
   * grows with every day of use and an unbounded read would load all of it.
   */
  list(userId: string, options?: ListSuggestionsOptions): Promise<Page<Suggestion>>;
  /** `null` when the id does not exist **or** belongs to someone else. */
  findById(userId: string, id: string): Promise<Suggestion | null>;
  create(userId: string, input: CreateSuggestionInput): Promise<Suggestion>;
  /**
   * Write a whole day's set atomically, or return the set already there.
   *
   * The agent produces one set per user per day, and a plain read-then-insert
   * cannot hold that: two refreshes arriving together — a double-tapped button,
   * a client retry over a slow model call — both see no rows and both insert,
   * leaving the user reading every suggestion twice. The invariant cannot be a
   * unique constraint either, since a day legitimately holds several rows.
   *
   * So the transaction takes a row lock on the caller's profile first, which
   * serialises refreshes per user without touching anyone else's. The loser of
   * the race gets the winner's rows back instead of writing its own.
   *
   * Note what this does *not* prevent: both callers have already paid for a
   * completion by the time they arrive here, because holding a transaction open
   * across a multi-second model call would be far worse than the duplicate spend.
   * Bounding that is a per-user rate limit's job — SLAI-19's.
   */
  createDailySet(
    userId: string,
    asOfDate: Date,
    inputs: CreateSuggestionInput[],
  ): Promise<Suggestion[]>;
  setStatus(userId: string, id: string, status: SuggestionStatus): Promise<Suggestion | null>;
}

function toDomain(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    userId: row.userId,
    // A `date` column comes back as UTC midnight; the date part is the value.
    asOfDate: row.asOfDate.toISOString().slice(0, 10),
    text: row.text,
    categoryId: row.categoryId ?? undefined,
    estMonthlySavings: { amountCents: row.estMonthlySavingsCents, currency: row.currency },
    rationale: row.rationale,
    sourceRefs: toStringArray(row.sourceRefs),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The insert payload, picked field by field — see the note in transactions.ts. */
function toCreateData(userId: string, input: CreateSuggestionInput) {
  return {
    asOfDate: input.asOfDate,
    text: input.text,
    categoryId: input.categoryId,
    estMonthlySavingsCents: input.estMonthlySavingsCents,
    currency: input.currency,
    rationale: input.rationale,
    sourceRefs: input.sourceRefs,
    userId,
  };
}

export function createSuggestionsRepository(
  prisma: Pick<PrismaClient, "suggestion" | "$transaction">,
): SuggestionsRepository {
  return {
    async list(userId, options = {}) {
      const size = pageSize(options.limit);
      try {
        const rows = await prisma.suggestion.findMany({
          where: {
            userId,
            ...(options.asOfDate ? { asOfDate: options.asOfDate } : {}),
            ...(options.status ? { status: options.status } : {}),
          },
          orderBy: LIST_ORDER,
          take: size + 1,
          ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        });
        return toPage(rows, size, toDomain);
      } catch (err) {
        // Same reasoning as transactions.list: only a supplied cursor may be blamed.
        if (options.cursor && isUnparseableUuid(err)) return { items: [], nextCursor: null };
        throw err;
      }
    },

    async findById(userId, id) {
      const row = await prisma.suggestion.findFirst({ where: { id, userId } });
      return row ? toDomain(row) : null;
    },

    async create(userId, input) {
      const row = await prisma.suggestion.create({ data: toCreateData(userId, input) });
      return toDomain(row);
    },

    async createDailySet(userId, asOfDate, inputs) {
      return prisma.$transaction(async (tx) => {
        // The lock is on the parent profile rather than on the suggestions
        // themselves: there is no row to lock when the set does not exist yet,
        // which is exactly the case being guarded.
        await tx.$executeRaw`SELECT 1 FROM user_profiles WHERE "userId" = ${userId}::uuid FOR UPDATE`;

        const existing = await tx.suggestion.findMany({
          where: { userId, asOfDate },
          orderBy: LIST_ORDER,
        });
        if (existing.length > 0) return existing.map(toDomain);

        const rows = [];
        for (const input of inputs) {
          rows.push(await tx.suggestion.create({ data: toCreateData(userId, input) }));
        }
        return rows.map(toDomain);
      });
    },

    async setStatus(userId, id, status) {
      const row = await nullIfNotFound(
        prisma.suggestion.update({ where: { id, userId }, data: { status } }),
      );
      return row ? toDomain(row) : null;
    },
  };
}
