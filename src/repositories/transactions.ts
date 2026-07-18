// Day-to-day spend events, scoped to their owner.
//
// The primary read is a filtered, cursor-paged list; ordering is
// `occurredAt desc, id asc` so paging is stable when several rows share a
// timestamp.

import type { PrismaClient, Transaction as TransactionRow } from "@prisma/client";
import type { Transaction } from "../domain/types";
import { isUnparseableUuid, nullIfNotFound, pageSize, toPage, type Page } from "./shared";

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

      try {
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
        return toPage(rows, size, toDomain);
      } catch (err) {
        // Only a supplied cursor may be blamed for an unparseable uuid — a
        // malformed `categoryId` must surface as an error, not as "no results".
        if (options.cursor && isUnparseableUuid(err)) return { items: [], nextCursor: null };
        throw err;
      }
    },

    async findById(userId, id) {
      const row = await prisma.transaction.findFirst({ where: { id, userId } });
      return row ? toDomain(row) : null;
    },

    async create(userId, input) {
      const row = await prisma.transaction.create({
        // Picked, not spread: `userId` last would already win, but an untyped
        // body could otherwise set `id` or `createdAt` too.
        data: {
          amountCents: input.amountCents,
          currency: input.currency,
          categoryId: input.categoryId,
          merchant: input.merchant,
          note: input.note,
          occurredAt: input.occurredAt ?? new Date(),
          userId,
        },
      });
      return toDomain(row);
    },

    async update(userId, id, patch) {
      const row = await nullIfNotFound(
        prisma.transaction.update({
          where: { id, userId },
          // Picked field by field rather than forwarding `patch`: a handler that
          // passes an untyped request body straight through must not be able to
          // reach `userId` (reassigning the row to someone else) or any other
          // column. `undefined` means "leave alone" to Prisma, so partial
          // updates still work; an explicit `null` still clears a nullable field.
          data: {
            amountCents: patch.amountCents,
            currency: patch.currency,
            categoryId: patch.categoryId,
            merchant: patch.merchant,
            note: patch.note,
            occurredAt: patch.occurredAt,
          },
        }),
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
