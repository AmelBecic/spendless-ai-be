// /fixed-expenses — the caller's recurring commitments (rent, subscriptions…).
//
// Every handler resolves the caller through `requireUser` and hands that id to
// the repository, which puts it in the `where`/`data` itself. No handler here
// builds a query, and none accepts a `userId` from the client: the request
// schemas are `.strict()`, so a body carrying one is a 400 rather than a field
// that gets quietly dropped.
//
// Deleting is a soft deactivate — the row stays for historical stats, which is
// why DELETE returns the (now inactive) expense rather than 204.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FixedExpense } from "../domain/types";
import type { CategoriesRepository } from "../repositories/categories";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import { requireUser } from "../auth/plugin";
import { AppError } from "../http/errors";
import { parseOrThrow } from "../http/validation";
import { amountCents, assertCategoryExists, categoryId, currency } from "./fields";

export interface FixedExpensesDeps {
  expenses: FixedExpensesRepository;
  /** Read to confirm `categoryId` refers to a real category before writing. */
  categories: CategoriesRepository;
}

/** The single-expense response body (POST, PATCH, DELETE). */
export interface FixedExpenseResponse {
  fixedExpense: FixedExpense;
}

/** The GET /fixed-expenses response body. */
export interface FixedExpensesResponse {
  fixedExpenses: FixedExpense[];
}

const label = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(120, "must be at most 120 characters");

const cadence = z.enum(["weekly", "monthly", "yearly"]);

const CreateBody = z.object({ label, categoryId, amountCents, currency, cadence }).strict();

const UpdateBody = z
  .object({
    label: label.optional(),
    categoryId: categoryId.optional(),
    amountCents: amountCents.optional(),
    currency: currency.optional(),
    cadence: cadence.optional(),
    // Reactivation is the counterpart to DELETE's soft deactivate.
    active: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "must change at least one field",
  });

const IdParams = z.object({ id: z.guid("must be a fixed expense id") }).strict();

// Query values arrive as strings; only the literal "true"/"false" are accepted
// so a typo'd filter fails loudly instead of being read as false.
const ListQuery = z
  .object({ active: z.enum(["true", "false"]).optional() })
  .strict()
  .transform(({ active }) => ({ active: active === undefined ? undefined : active === "true" }));

function notFound(): AppError {
  // Someone else's id and a nonexistent id are deliberately the same answer —
  // a 404 here must not confirm that a row exists on another account.
  return new AppError(404, "NOT_FOUND", "fixed expense not found");
}

export function registerFixedExpensesRoutes(app: FastifyInstance, deps: FixedExpensesDeps): void {
  const guard = { preHandler: app.authenticate };

  app.get("/fixed-expenses", guard, async (req): Promise<FixedExpensesResponse> => {
    const user = requireUser(req);
    const { active } = parseOrThrow(ListQuery, req.query, "invalid query parameters");
    return { fixedExpenses: await deps.expenses.list(user.id, { active }) };
  });

  app.post("/fixed-expenses", guard, async (req, reply): Promise<FixedExpenseResponse> => {
    const user = requireUser(req);
    const body = parseOrThrow(CreateBody, req.body, "invalid fixed expense");
    await assertCategoryExists(deps.categories, body.categoryId);

    const fixedExpense = await deps.expenses.create(user.id, body);
    void reply.status(201);
    return { fixedExpense };
  });

  app.patch("/fixed-expenses/:id", guard, async (req): Promise<FixedExpenseResponse> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid fixed expense id");
    const patch = parseOrThrow(UpdateBody, req.body, "invalid fixed expense");
    if (patch.categoryId !== undefined)
      await assertCategoryExists(deps.categories, patch.categoryId);

    const fixedExpense = await deps.expenses.update(user.id, id, patch);
    if (!fixedExpense) throw notFound();
    return { fixedExpense };
  });

  app.delete("/fixed-expenses/:id", guard, async (req): Promise<FixedExpenseResponse> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid fixed expense id");

    const fixedExpense = await deps.expenses.deactivate(user.id, id);
    if (!fixedExpense) throw notFound();
    return { fixedExpense };
  });
}
