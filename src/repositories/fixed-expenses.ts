// Fixed (recurring) expenses, scoped to their owner.
//
// Every method takes `userId` and puts it in the `where` (reads, updates) or the
// `data` (creates). The input types deliberately carry no `userId` field, so a
// caller cannot pass one and have it override the scope.

import type { PrismaClient, FixedExpense as FixedExpenseRow } from "@prisma/client";
import type { Cadence, FixedExpense } from "../domain/types";
import { nullIfNotFound } from "./shared";

export interface CreateFixedExpenseInput {
  label: string;
  categoryId: string;
  amountCents: number;
  currency: string;
  cadence: Cadence;
}

export interface UpdateFixedExpenseInput {
  label?: string;
  categoryId?: string;
  amountCents?: number;
  currency?: string;
  cadence?: Cadence;
  active?: boolean;
}

export interface ListFixedExpensesOptions {
  /** Omitted returns both active and inactive. */
  active?: boolean;
}

export interface FixedExpensesRepository {
  /**
   * Unpaged by design: a fixed expense is a standing commitment a person
   * actively maintains, so the set is bounded by hand (tens of rows) and does
   * not grow with use the way transactions and suggestions do. Callers want the
   * whole set anyway — totals over a partial page would be wrong.
   */
  list(userId: string, options?: ListFixedExpensesOptions): Promise<FixedExpense[]>;
  /** `null` when the id does not exist **or** belongs to someone else. */
  findById(userId: string, id: string): Promise<FixedExpense | null>;
  create(userId: string, input: CreateFixedExpenseInput): Promise<FixedExpense>;
  update(
    userId: string,
    id: string,
    patch: UpdateFixedExpenseInput,
  ): Promise<FixedExpense | null>;
  /** Soft delete: flips `active` to false, keeping the row for historical stats. */
  deactivate(userId: string, id: string): Promise<FixedExpense | null>;
}

function toDomain(row: FixedExpenseRow): FixedExpense {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    categoryId: row.categoryId,
    money: { amountCents: row.amountCents, currency: row.currency },
    cadence: row.cadence,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createFixedExpensesRepository(
  prisma: Pick<PrismaClient, "fixedExpense">,
): FixedExpensesRepository {
  return {
    async list(userId, options = {}) {
      const rows = await prisma.fixedExpense.findMany({
        where: { userId, ...(options.active === undefined ? {} : { active: options.active }) },
        // Deterministic: newest first, id breaking ties on identical timestamps.
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      return rows.map(toDomain);
    },

    async findById(userId, id) {
      const row = await prisma.fixedExpense.findFirst({ where: { id, userId } });
      return row ? toDomain(row) : null;
    },

    async create(userId, input) {
      const row = await prisma.fixedExpense.create({
        // Picked, not spread — see the note in transactions.ts.
        data: {
          label: input.label,
          categoryId: input.categoryId,
          amountCents: input.amountCents,
          currency: input.currency,
          cadence: input.cadence,
          userId,
        },
      });
      return toDomain(row);
    },

    async update(userId, id, patch) {
      const row = await nullIfNotFound(
        prisma.fixedExpense.update({
          where: { id, userId },
          // Picked explicitly so an untyped request body forwarded by a handler
          // cannot reach `userId` or any column outside this list. See the same
          // note in transactions.ts.
          data: {
            label: patch.label,
            categoryId: patch.categoryId,
            amountCents: patch.amountCents,
            currency: patch.currency,
            cadence: patch.cadence,
            active: patch.active,
          },
        }),
      );
      return row ? toDomain(row) : null;
    },

    async deactivate(userId, id) {
      const row = await nullIfNotFound(
        prisma.fixedExpense.update({ where: { id, userId }, data: { active: false } }),
      );
      return row ? toDomain(row) : null;
    },
  };
}
