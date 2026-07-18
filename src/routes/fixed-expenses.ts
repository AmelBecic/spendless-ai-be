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
import { AppError, ValidationError } from "../http/errors";
import { parseOrThrow } from "../http/validation";

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

// Integer cents only: `.int()` rejects a float outright rather than rounding it,
// so an amount can never lose precision on the way in.
//
// The upper bound is the storage bound, not a product rule: `amountCents` is a
// Prisma `Int`, i.e. Postgres int4. Without it, 2_147_483_648 passes validation
// and overflows at the database — the 500 that the categoryId check exists to
// avoid, in a different guise. Verified against the column: 2_147_483_647
// stores, one more raises.
const INT4_MAX = 2_147_483_647;

const amountCents = z
  .number()
  .int("must be an integer number of cents")
  .positive("must be greater than 0")
  .max(INT4_MAX, "is too large");

// Stored as written, so normalise case here — "eur" and "EUR" must not become
// two currencies that money arithmetic then refuses to combine.
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO-4217 code");

const cadence = z.enum(["weekly", "monthly", "yearly"]);

// `guid`, not `uuid`: the shape check is what keeps an unparseable value from
// reaching a uuid column (Postgres would raise P2023), but the *version* nibble
// is not ours to assert — these ids are minted by the database, and pinning v4
// here would turn a future v7 id into "malformed input". Probed: z.uuid()
// rejects a non-v4 uuid, z.guid() accepts any uuid-shaped string.
const categoryId = z.guid("must be a category id");

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

/**
 * Confirm the category exists, as a 400 on `categoryId` rather than the 500 the
 * foreign key would otherwise raise. The category set is bounded reference data
 * (see repositories/categories.ts), so listing it is a cheap read of a small
 * table, not a scan that grows with use.
 */
async function assertCategoryExists(deps: FixedExpensesDeps, id: string): Promise<void> {
  const categories = await deps.categories.list();
  if (!categories.some((category) => category.id === id)) {
    throw new ValidationError([{ path: "categoryId", message: "no such category" }]);
  }
}

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
    await assertCategoryExists(deps, body.categoryId);

    const fixedExpense = await deps.expenses.create(user.id, body);
    void reply.status(201);
    return { fixedExpense };
  });

  app.patch("/fixed-expenses/:id", guard, async (req): Promise<FixedExpenseResponse> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid fixed expense id");
    const patch = parseOrThrow(UpdateBody, req.body, "invalid fixed expense");
    if (patch.categoryId !== undefined) await assertCategoryExists(deps, patch.categoryId);

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
