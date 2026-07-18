// Day-to-day spend events, scoped to their owner.
//
// The primary read is a filtered, cursor-paged list; ordering is
// `occurredAt desc, id asc` so paging is stable when several rows share a
// timestamp.

import type { PrismaClient, Transaction as TransactionRow } from "@prisma/client";
import type { Transaction } from "../domain/types";
import { nullIfNotFound, pageSize, type Page } from "./shared";

export interface CreateTransactionInput {
  amountCents: number;
  currency: string;
  categoryId: string;
  merchant?: string | null;
  note?: string | null;
  /** Defaults to now when omitted. */
  occurredAt?: Date;
}

export interface UpdateTransactionInput {
  amountCents?: number;
  currency?: string;
  categoryId?: string;
  merchant?: string | null;
  note?: string | null;
  occurredAt?: Date;
}

export interface ListTransactionsOptions {
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date;
  /** Inclusive upper bound on `occurredAt`. */
  to?: Date;
  categoryId?: string;
  /** Clamped to 1..200; defaults to 50. */
  limit?: number;
  /** Id of the last row of the previous page. */
  cursor?: string;
}

export interface TransactionsRepository {
  list(userId: string, options?: ListTransactionsOptions): Promise<Page<Transaction>>;
  /** `null` when the id does not exist **or** belongs to someone else. */
  findById(userId: string, id: string): Promise<Transaction | null>;
  create(userId: string, input: CreateTransactionInput): Promise<Transaction>;
  update(userId: string, id: string, patch: UpdateTransactionInput): Promise<Transaction | null>;
  /** `false` when the id does not exist **or** belongs to someone else. */
  delete(userId: string, id: string): Promise<boolean>;
}

function toDomain(row: TransactionRow): Transaction {
  return {
    id: row.id,
    userId: row.userId,
    money: { amountCents: row.amountCents, currency: row.currency },
    categoryId: row.categoryId,
    merchant: row.merchant ?? undefined,
    note: row.note ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function createTransactionsRepository(
  prisma: Pick<PrismaClient, "transaction">,
): TransactionsRepository {
  return {
    async list(userId, options = {}) {
      const size = pageSize(options.limit);
      const occurredAt =
        options.from || options.to
          ? {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            }
          : undefined;

      const rows = await prisma.transaction.findMany({
        // `userId` is in the where regardless of the cursor, so a cursor id
        // lifted from another user still cannot surface that user's rows.
        where: {
          userId,
          ...(occurredAt ? { occurredAt } : {}),
          ...(options.categoryId ? { categoryId: options.categoryId } : {}),
        },
        orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
        // One extra row tells us whether a further page exists without a count query.
        take: size + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      });

      const items = rows.slice(0, size).map(toDomain);
      const nextCursor = rows.length > size ? (items.at(-1)?.id ?? null) : null;
      return { items, nextCursor };
    },

    async findById(userId, id) {
      const row = await prisma.transaction.findFirst({ where: { id, userId } });
      return row ? toDomain(row) : null;
    },

    async create(userId, input) {
      const row = await prisma.transaction.create({
        data: { ...input, userId, occurredAt: input.occurredAt ?? new Date() },
      });
      return toDomain(row);
    },

    async update(userId, id, patch) {
      const row = await nullIfNotFound(
        prisma.transaction.update({ where: { id, userId }, data: patch }),
      );
      return row ? toDomain(row) : null;
    },

    async delete(userId, id) {
      // deleteMany takes a non-unique where, so the scope is applied in the same
      // statement — no read-then-delete window.
      const { count } = await prisma.transaction.deleteMany({ where: { id, userId } });
      return count === 1;
    },
  };
}
