// Grounded savings suggestions, scoped to their owner.
//
// The agent writes these; the user reads them and flips their status. Both sides
// go through here, so a suggestion computed for one user can never be listed or
// dismissed by another.

import type { PrismaClient, Suggestion as SuggestionRow } from "@prisma/client";
import type { Suggestion, SuggestionStatus } from "../domain/types";
import { nullIfNotFound, toStringArray } from "./shared";

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
}

export interface SuggestionsRepository {
  list(userId: string, options?: ListSuggestionsOptions): Promise<Suggestion[]>;
  /** `null` when the id does not exist **or** belongs to someone else. */
  findById(userId: string, id: string): Promise<Suggestion | null>;
  create(userId: string, input: CreateSuggestionInput): Promise<Suggestion>;
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

export function createSuggestionsRepository(
  prisma: Pick<PrismaClient, "suggestion">,
): SuggestionsRepository {
  return {
    async list(userId, options = {}) {
      const rows = await prisma.suggestion.findMany({
        where: {
          userId,
          ...(options.asOfDate ? { asOfDate: options.asOfDate } : {}),
          ...(options.status ? { status: options.status } : {}),
        },
        // Most recent day first; id breaks ties so the order is total.
        orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      });
      return rows.map(toDomain);
    },

    async findById(userId, id) {
      const row = await prisma.suggestion.findFirst({ where: { id, userId } });
      return row ? toDomain(row) : null;
    },

    async create(userId, input) {
      const row = await prisma.suggestion.create({ data: { ...input, userId } });
      return toDomain(row);
    },

    async setStatus(userId, id, status) {
      const row = await nullIfNotFound(
        prisma.suggestion.update({ where: { id, userId }, data: { status } }),
      );
      return row ? toDomain(row) : null;
    },
  };
}
