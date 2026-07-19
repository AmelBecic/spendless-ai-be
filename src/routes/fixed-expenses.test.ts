import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { Category, FixedExpense } from "../domain/types";
import type { AuthDeps } from "../auth/plugin";
import type {
  FixedExpensesRepository,
  CreateFixedExpenseInput,
} from "../repositories/fixed-expenses";
import {
  emptyCategories,
  unusedLlm,
  unusedProfiles,
  unusedSummaries,
  unusedSuggestions,
  unusedTransactions,
} from "../test/stubs";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

const CATEGORY_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "99999999-9999-9999-9999-999999999999";

// Ids are uuid-shaped because the routes validate them as such before querying —
// a `where` on a uuid column rejects anything else at the database.
const expenseId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const EXPENSE_1 = expenseId(1);
const EXPENSE_2 = expenseId(2);
const MISSING_ID = expenseId(9);

const categories: Category[] = [{ id: CATEGORY_ID, key: "housing", label: "Housing" }];
const categoriesRepo = { list: async () => categories };

const authAs = (id: string): AuthDeps => ({
  verifier: { verify: async () => ({ id }) },
  profiles: { ensureProfile: async () => {} },
});

const USER = "user-1";
const acceptingAuth = authAs(USER);

/**
 * An in-memory stand-in that enforces the same `userId` scoping the real
 * repository does. Without that the isolation assertions below would pass
 * against a store that simply ignores the caller — proving nothing.
 */
function fakeRepo(seed: FixedExpense[] = []): FixedExpensesRepository & { rows: FixedExpense[] } {
  const rows = [...seed];
  const owned = (userId: string, id: string) =>
    rows.find((row) => row.id === id && row.userId === userId);

  return {
    rows,
    async list(userId, options = {}) {
      return rows.filter(
        (row) =>
          row.userId === userId && (options.active === undefined || row.active === options.active),
      );
    },
    async findById(userId, id) {
      return owned(userId, id) ?? null;
    },
    async create(userId, input: CreateFixedExpenseInput) {
      const row: FixedExpense = {
        id: expenseId(rows.length + 1),
        userId,
        label: input.label,
        categoryId: input.categoryId,
        money: { amountCents: input.amountCents, currency: input.currency },
        cadence: input.cadence,
        active: true,
        createdAt: "2026-07-18T00:00:00.000Z",
      };
      rows.push(row);
      return row;
    },
    async update(userId, id, patch) {
      const row = owned(userId, id);
      if (!row) return null;
      const updated: FixedExpense = {
        ...row,
        label: patch.label ?? row.label,
        categoryId: patch.categoryId ?? row.categoryId,
        money: {
          amountCents: patch.amountCents ?? row.money.amountCents,
          currency: patch.currency ?? row.money.currency,
        },
        cadence: patch.cadence ?? row.cadence,
        active: patch.active ?? row.active,
      };
      rows[rows.indexOf(row)] = updated;
      return updated;
    },
    async deactivate(userId, id) {
      const row = owned(userId, id);
      if (!row) return null;
      const updated = { ...row, active: false };
      rows[rows.indexOf(row)] = updated;
      return updated;
    },
  };
}

function appWith(expenses: FixedExpensesRepository, auth = acceptingAuth, cats = categoriesRepo) {
  return buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth,
    llm: unusedLlm,
    repos: {
      categories: cats,
      expenses,
      transactions: unusedTransactions,
      profiles: unusedProfiles,
      summaries: unusedSummaries,
      suggestions: unusedSuggestions,
    },
  });
}

const AUTH = { authorization: "Bearer good-token" };

const validBody = {
  label: "Rent",
  categoryId: CATEGORY_ID,
  amountCents: 120_000,
  currency: "EUR",
  cadence: "monthly",
};

const expense = (over: Partial<FixedExpense> = {}): FixedExpense => ({
  id: EXPENSE_1,
  userId: USER,
  label: "Rent",
  categoryId: CATEGORY_ID,
  money: { amountCents: 120_000, currency: "EUR" },
  cadence: "monthly",
  active: true,
  createdAt: "2026-07-18T00:00:00.000Z",
  ...over,
});

describe("POST /fixed-expenses", () => {
  it("creates the expense for the calling user and returns 201", async () => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: validBody,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().fixedExpense).toMatchObject({
      userId: USER,
      label: "Rent",
      money: { amountCents: 120_000, currency: "EUR" },
      cadence: "monthly",
      active: true,
    });
    await app.close();
  });

  it("normalises currency case so one currency cannot become two", async () => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: { ...validBody, currency: "eur" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().fixedExpense.money.currency).toBe("EUR");
    await app.close();
  });

  it.each([
    ["label", { label: "   " }, "label"],
    ["amountCents zero", { amountCents: 0 }, "amountCents"],
    ["amountCents negative", { amountCents: -1 }, "amountCents"],
    ["amountCents float", { amountCents: 12.5 }, "amountCents"],
    // int4 is the storage bound — one past it used to overflow into a 500.
    ["amountCents past int4", { amountCents: 2_147_483_648 }, "amountCents"],
    ["currency", { currency: "EURO" }, "currency"],
    ["cadence", { cadence: "daily" }, "cadence"],
    ["categoryId", { categoryId: "not-a-uuid" }, "categoryId"],
  ])("rejects invalid %s with a field-level 400 and never writes", async (_name, patch, field) => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: { ...validBody, ...patch },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    // The AC's "never reaching the DB" — nothing was persisted.
    expect(repo.rows).toEqual([]);
    await app.close();
  });

  it("reports every offending field at once, not just the first", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: { ...validBody, label: "", amountCents: -5, cadence: "hourly" },
    });

    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["label", "amountCents", "cadence"]));
    await app.close();
  });

  it("rejects a categoryId that does not exist, before writing", async () => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: { ...validBody, categoryId: OTHER_ID },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([{ path: "categoryId", message: "no such category" }]);
    expect(repo.rows).toEqual([]);
    await app.close();
  });

  it("rejects a body carrying userId rather than letting it pick the owner", async () => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: { ...validBody, userId: "someone-else" },
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows).toEqual([]);
    await app.close();
  });

  it("rejects an unauthenticated request without touching the repository", async () => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({ method: "POST", url: "/fixed-expenses", payload: validBody });

    expect(res.statusCode).toBe(401);
    expect(repo.rows).toEqual([]);
    await app.close();
  });
});

describe("GET /fixed-expenses", () => {
  it("returns only the caller's expenses", async () => {
    const repo = fakeRepo([
      expense({ id: EXPENSE_1, label: "Mine" }),
      expense({ id: EXPENSE_2, userId: "user-2", label: "Theirs" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({ method: "GET", url: "/fixed-expenses", headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().fixedExpenses.map((e: FixedExpense) => e.label)).toEqual(["Mine"]);
    await app.close();
  });

  it("filters on ?active", async () => {
    const repo = fakeRepo([
      expense({ id: EXPENSE_1, label: "Live" }),
      expense({ id: EXPENSE_2, label: "Cancelled", active: false }),
    ]);
    const app = appWith(repo);

    const active = await app.inject({
      method: "GET",
      url: "/fixed-expenses?active=true",
      headers: AUTH,
    });
    const inactive = await app.inject({
      method: "GET",
      url: "/fixed-expenses?active=false",
      headers: AUTH,
    });

    expect(active.json().fixedExpenses.map((e: FixedExpense) => e.label)).toEqual(["Live"]);
    expect(inactive.json().fixedExpenses.map((e: FixedExpense) => e.label)).toEqual(["Cancelled"]);
    await app.close();
  });

  it("rejects a malformed ?active rather than silently reading it as false", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "GET",
      url: "/fixed-expenses?active=yes",
      headers: AUTH,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("active");
    await app.close();
  });

  it("requires authentication", async () => {
    const app = appWith(fakeRepo());
    const res = await app.inject({ method: "GET", url: "/fixed-expenses" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("PATCH /fixed-expenses/:id", () => {
  it("updates the caller's expense", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: { label: "Rent (raised)", amountCents: 130_000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fixedExpense).toMatchObject({
      label: "Rent (raised)",
      money: { amountCents: 130_000, currency: "EUR" },
    });
    await app.close();
  });

  it("can reactivate a soft-deleted expense", async () => {
    const repo = fakeRepo([expense({ active: false })]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: { active: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fixedExpense.active).toBe(true);
    await app.close();
  });

  it("404s on another user's expense and leaves it untouched", async () => {
    const repo = fakeRepo([expense({ userId: "user-2" })]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: { label: "hijacked" },
    });

    expect(res.statusCode).toBe(404);
    expect(repo.rows[0]!.label).toBe("Rent");
    await app.close();
  });

  it("rejects an empty patch", async () => {
    const app = appWith(fakeRepo([expense()]));

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("validates patched fields the same way as create", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: { amountCents: -1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("amountCents");
    expect(repo.rows[0]!.money.amountCents).toBe(120_000);
    await app.close();
  });

  it("rejects a patch moving the row to an unknown category, before writing", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: { categoryId: OTHER_ID },
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows[0]!.categoryId).toBe(CATEGORY_ID);
    await app.close();
  });

  it("rejects a patch carrying userId", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
      payload: { userId: "user-2" },
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows[0]!.userId).toBe(USER);
    await app.close();
  });

  it("requires authentication", async () => {
    const app = appWith(fakeRepo([expense()]));
    const res = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${EXPENSE_1}`,
      payload: { label: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("DELETE /fixed-expenses/:id", () => {
  it("soft-deactivates rather than removing the row", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "DELETE",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fixedExpense.active).toBe(false);
    // The row survives — historical stats still need it.
    expect(repo.rows).toHaveLength(1);
    await app.close();
  });

  it("404s on another user's expense and leaves it active", async () => {
    const repo = fakeRepo([expense({ userId: "user-2" })]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "DELETE",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(404);
    expect(repo.rows[0]!.active).toBe(true);
    await app.close();
  });

  it("404s on an id that does not exist", async () => {
    const app = appWith(fakeRepo());
    const res = await app.inject({
      method: "DELETE",
      url: `/fixed-expenses/${MISSING_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("requires authentication", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);
    const res = await app.inject({ method: "DELETE", url: `/fixed-expenses/${EXPENSE_1}` });
    expect(res.statusCode).toBe(401);
    expect(repo.rows[0]!.active).toBe(true);
    await app.close();
  });

  // Regression: most HTTP clients set a JSON content-type on every request,
  // body or not. Fastify's stock parser 500s on the resulting empty body, so a
  // routine `curl -X DELETE -H 'content-type: application/json'` used to fail.
  it("accepts a JSON content-type with no body", async () => {
    const repo = fakeRepo([expense()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "DELETE",
      url: `/fixed-expenses/${EXPENSE_1}`,
      headers: { ...AUTH, "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(repo.rows[0]!.active).toBe(false);
    await app.close();
  });
});

describe("request body parsing", () => {
  it("treats an empty JSON body as a missing one — 400, not 500", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "",
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects malformed JSON with a 400 envelope", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{ not json",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
    await app.close();
  });
});

describe("category validation", () => {
  it("rejects every create when no category is seeded", async () => {
    const repo = fakeRepo();
    const app = appWith(repo, acceptingAuth, emptyCategories);

    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: validBody,
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows).toEqual([]);
    await app.close();
  });
});
