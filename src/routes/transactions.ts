// /transactions — the caller's day-to-day spend events.
//
// Same scoping contract as /fixed-expenses: every handler resolves the caller
// through `requireUser` and hands that id to the repository, which puts it in
// the `where`/`data` itself. The request schemas are `.strict()`, so a body
// carrying `userId` is a 400 rather than a field that gets quietly dropped.
//
// Unlike a fixed expense, a transaction is a plain event with no historical
// role once it is retracted, so DELETE really deletes and returns 204.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Transaction } from "../domain/types";
import type { CategoriesRepository } from "../repositories/categories";
import type { TransactionsRepository } from "../repositories/transactions";
import { MAX_PAGE_SIZE } from "../repositories/shared";
import { requireUser } from "../auth/plugin";
import { AppError } from "../http/errors";
import { parseOrThrow } from "../http/validation";
import {
  amountCents,
  assertCategoryExists,
  categoryId,
  currency,
  inclusiveEndTimestamp,
  optionalText,
  timestamp,
} from "./fields";

export interface TransactionsDeps {
  transactions: TransactionsRepository;
  /** Read to confirm `categoryId` refers to a real category before writing. */
  categories: CategoriesRepository;
}

/** The single-transaction response body (POST, GET /:id, PATCH). */
export interface TransactionResponse {
  transaction: Transaction;
}

/** The GET /transactions response body — one page plus the cursor for the next. */
export interface TransactionsResponse {
  transactions: Transaction[];
  /** `null` once the listing is exhausted. */
  nextCursor: string | null;
}

const merchant = optionalText(200);
const note = optionalText(2000);

const CreateBody = z
  .object({
    amountCents,
    currency,
    categoryId,
    merchant: merchant.optional(),
    note: note.optional(),
    // Omitted means "now" — the repository supplies the default so the clock is
    // read in one place.
    occurredAt: timestamp.optional(),
  })
  .strict();

const UpdateBody = z
  .object({
    amountCents: amountCents.optional(),
    currency: currency.optional(),
    categoryId: categoryId.optional(),
    // Nullable as well as optional: absent leaves the field alone, explicit null
    // clears it. Without the distinction there is no way to remove a merchant.
    merchant: merchant.nullable().optional(),
    note: note.nullable().optional(),
    occurredAt: timestamp.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "must change at least one field",
  });

const IdParams = z.object({ id: z.guid("must be a transaction id") }).strict();

// Query values arrive as strings. `limit` is validated against the repository's
// clamp rather than left to it: a caller asking for 5000 rows has misunderstood
// the endpoint, and silently returning 200 of them hides that.
const ListQuery = z
  .object({
    from: timestamp.optional(),
    // Inclusive to the end of the day when given as a bare date — see fields.ts.
    to: inclusiveEndTimestamp.optional(),
    categoryId: categoryId.optional(),
    limit: z.coerce
      .number()
      .int("must be a whole number")
      .positive("must be greater than 0")
      .max(MAX_PAGE_SIZE, `must be at most ${MAX_PAGE_SIZE}`)
      .optional(),
    cursor: z.guid("must be a transaction id").optional(),
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ["from"],
    message: "must not be after `to`",
  });

function notFound(): AppError {
  // Someone else's id and a nonexistent id are deliberately the same answer —
  // a 404 here must not confirm that a row exists on another account.
  return new AppError(404, "NOT_FOUND", "transaction not found");
}

export function registerTransactionsRoutes(app: FastifyInstance, deps: TransactionsDeps): void {
  const guard = { preHandler: app.authenticate };

  app.get("/transactions", guard, async (req): Promise<TransactionsResponse> => {
    const user = requireUser(req);
    const query = parseOrThrow(ListQuery, req.query, "invalid query parameters");

    const page = await deps.transactions.list(user.id, query);
    return { transactions: page.items, nextCursor: page.nextCursor };
  });

  app.get("/transactions/:id", guard, async (req): Promise<TransactionResponse> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid transaction id");

    const transaction = await deps.transactions.findById(user.id, id);
    if (!transaction) throw notFound();
    return { transaction };
  });

  app.post("/transactions", guard, async (req, reply): Promise<TransactionResponse> => {
    const user = requireUser(req);
    const body = parseOrThrow(CreateBody, req.body, "invalid transaction");
    await assertCategoryExists(deps.categories, body.categoryId);

    const transaction = await deps.transactions.create(user.id, body);
    void reply.status(201);
    return { transaction };
  });

  app.patch("/transactions/:id", guard, async (req): Promise<TransactionResponse> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid transaction id");
    const patch = parseOrThrow(UpdateBody, req.body, "invalid transaction");
    if (patch.categoryId !== undefined)
      await assertCategoryExists(deps.categories, patch.categoryId);

    const transaction = await deps.transactions.update(user.id, id, patch);
    if (!transaction) throw notFound();
    return { transaction };
  });

  app.delete("/transactions/:id", guard, async (req, reply): Promise<void> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid transaction id");

    if (!(await deps.transactions.delete(user.id, id))) throw notFound();
    void reply.status(204);
  });
}
