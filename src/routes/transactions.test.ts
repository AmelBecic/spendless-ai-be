import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { Category, Transaction } from "../domain/types";
import type { AuthDeps } from "../auth/plugin";
import type { TransactionsRepository } from "../repositories/transactions";
import { emptyCategories, unusedFixedExpenses } from "../test/stubs";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

const CATEGORY_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "99999999-9999-9999-9999-999999999999";

// Ids are uuid-shaped because the routes validate them as such before querying —
// a `where` on a uuid column rejects anything else at the database.
const txId = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
const TX_1 = txId(1);
const TX_2 = txId(2);
const MISSING_ID = txId(9);

const categories: Category[] = [{ id: CATEGORY_ID, key: "food", label: "Food" }];
const categoriesRepo = { list: async () => categories };

const authAs = (id: string): AuthDeps => ({
  verifier: { verify: async () => ({ id }) },
  profiles: { ensureProfile: async () => {} },
});

const USER = "user-1";
const acceptingAuth = authAs(USER);

/**
 * An in-memory stand-in that enforces the same `userId` scoping — and the same
 * `occurredAt desc, id asc` ordering — the real repository does. Without the
 * scoping the isolation assertions would pass against a store that ignores the
 * caller; without the ordering the pagination assertions would prove nothing.
 */
function fakeRepo(seed: Transaction[] = []): TransactionsRepository & { rows: Transaction[] } {
  const rows = [...seed];
  const owned = (userId: string, id: string) =>
    rows.find((row) => row.id === id && row.userId === userId);

  return {
    rows,
    async list(userId, options = {}) {
      const size = options.limit ?? 50;
      const matching = rows
        .filter((row) => row.userId === userId)
        .filter((row) => !options.from || new Date(row.occurredAt) >= options.from)
        .filter((row) => !options.to || new Date(row.occurredAt) <= options.to)
        .filter((row) => !options.categoryId || row.categoryId === options.categoryId)
        .sort((a, b) =>
          a.occurredAt === b.occurredAt
            ? a.id.localeCompare(b.id)
            : b.occurredAt.localeCompare(a.occurredAt),
        );

      const start = options.cursor ? matching.findIndex((row) => row.id === options.cursor) + 1 : 0;
      const page = matching.slice(start, start + size);
      return {
        items: page,
        nextCursor: start + size < matching.length ? (page.at(-1)?.id ?? null) : null,
      };
    },
    async findById(userId, id) {
      return owned(userId, id) ?? null;
    },
    async create(userId, input) {
      const row: Transaction = {
        id: txId(rows.length + 1),
        userId,
        money: { amountCents: input.amountCents, currency: input.currency },
        categoryId: input.categoryId,
        merchant: input.merchant ?? undefined,
        note: input.note ?? undefined,
        occurredAt: (input.occurredAt ?? new Date("2026-07-18T12:00:00.000Z")).toISOString(),
        createdAt: "2026-07-18T00:00:00.000Z",
      };
      rows.push(row);
      return row;
    },
    async update(userId, id, patch) {
      const row = owned(userId, id);
      if (!row) return null;
      const updated: Transaction = {
        ...row,
        money: {
          amountCents: patch.amountCents ?? row.money.amountCents,
          currency: patch.currency ?? row.money.currency,
        },
        categoryId: patch.categoryId ?? row.categoryId,
        // `undefined` leaves the field alone, an explicit `null` clears it.
        merchant: patch.merchant === undefined ? row.merchant : (patch.merchant ?? undefined),
        note: patch.note === undefined ? row.note : (patch.note ?? undefined),
        occurredAt: patch.occurredAt ? patch.occurredAt.toISOString() : row.occurredAt,
      };
      rows[rows.indexOf(row)] = updated;
      return updated;
    },
    async delete(userId, id) {
      const row = owned(userId, id);
      if (!row) return false;
      rows.splice(rows.indexOf(row), 1);
      return true;
    },
  };
}

function appWith(
  transactions: TransactionsRepository,
  auth = acceptingAuth,
  cats = categoriesRepo,
) {
  return buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth,
    repos: { categories: cats, expenses: unusedFixedExpenses, transactions },
  });
}

const AUTH = { authorization: "Bearer good-token" };

const validBody = {
  amountCents: 1_250,
  currency: "EUR",
  categoryId: CATEGORY_ID,
  merchant: "Cafe",
  occurredAt: "2026-07-18T09:30:00.000Z",
};

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: TX_1,
  userId: USER,
  money: { amountCents: 1_250, currency: "EUR" },
  categoryId: CATEGORY_ID,
  merchant: "Cafe",
  occurredAt: "2026-07-18T09:30:00.000Z",
  createdAt: "2026-07-18T00:00:00.000Z",
  ...over,
});

describe("POST /transactions", () => {
  it("creates the transaction for the calling user and returns 201", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: validBody,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().transaction).toMatchObject({
      userId: USER,
      money: { amountCents: 1_250, currency: "EUR" },
      categoryId: CATEGORY_ID,
      merchant: "Cafe",
      occurredAt: "2026-07-18T09:30:00.000Z",
    });
    await app.close();
  });

  it("defaults occurredAt when it is omitted", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: { amountCents: 500, currency: "EUR", categoryId: CATEGORY_ID },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.occurredAt).toBeTruthy();
    await app.close();
  });

  it("accepts an explicit UTC offset and resolves it to the right instant", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      // 00:30 at +02:00 is 22:30Z the *previous* day — the offset must be
      // applied, not ignored, or the spend lands in the wrong day (or month).
      payload: { ...validBody, occurredAt: "2026-07-02T00:30:00+02:00" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.occurredAt).toBe("2026-07-01T22:30:00.000Z");
    await app.close();
  });

  it("normalises currency case so one currency cannot become two", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: { ...validBody, currency: "eur" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.money.currency).toBe("EUR");
    await app.close();
  });

  it.each([
    ["amountCents zero", { amountCents: 0 }, "amountCents"],
    ["amountCents negative", { amountCents: -1 }, "amountCents"],
    // The AC's "a float amount is rejected" — no silent rounding.
    ["amountCents float", { amountCents: 12.5 }, "amountCents"],
    ["amountCents as a string", { amountCents: "1250" }, "amountCents"],
    // int4 is the storage bound — one past it would overflow into a 500.
    ["amountCents past int4", { amountCents: 2_147_483_648 }, "amountCents"],
    ["currency", { currency: "EURO" }, "currency"],
    ["categoryId", { categoryId: "not-a-uuid" }, "categoryId"],
    ["occurredAt", { occurredAt: "yesterday" }, "occurredAt"],
    ["occurredAt impossible date", { occurredAt: "2026-02-31" }, "occurredAt"],
    // No `Z`/offset would be read as server-local time, so the same request
    // would mean a different instant on every host.
    ["occurredAt without a zone", { occurredAt: "2026-07-18T09:30:00" }, "occurredAt"],
  ])("rejects invalid %s with a field-level 400 and never writes", async (_name, patch, field) => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
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
      url: "/transactions",
      headers: AUTH,
      payload: { ...validBody, amountCents: -5, currency: "E", occurredAt: "nope" },
    });

    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["amountCents", "currency", "occurredAt"]));
    await app.close();
  });

  it("rejects a categoryId that does not exist, before writing", async () => {
    const repo = fakeRepo();
    const app = appWith(repo);

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
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
      url: "/transactions",
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

    const res = await app.inject({ method: "POST", url: "/transactions", payload: validBody });

    expect(res.statusCode).toBe(401);
    expect(repo.rows).toEqual([]);
    await app.close();
  });
});

describe("GET /transactions", () => {
  it("returns only the caller's transactions", async () => {
    const repo = fakeRepo([
      tx({ id: TX_1, merchant: "Mine" }),
      tx({ id: TX_2, userId: "user-2", merchant: "Theirs" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({ method: "GET", url: "/transactions", headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions.map((t: Transaction) => t.merchant)).toEqual(["Mine"]);
    await app.close();
  });

  it("orders by occurredAt desc with the id as tiebreak", async () => {
    const repo = fakeRepo([
      tx({ id: txId(2), occurredAt: "2026-07-10T00:00:00.000Z" }),
      tx({ id: txId(3), occurredAt: "2026-07-20T00:00:00.000Z" }),
      // Same timestamp as txId(3) — the id decides, deterministically.
      tx({ id: txId(1), occurredAt: "2026-07-20T00:00:00.000Z" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({ method: "GET", url: "/transactions", headers: AUTH });

    expect(res.json().transactions.map((t: Transaction) => t.id)).toEqual([
      txId(1),
      txId(3),
      txId(2),
    ]);
    await app.close();
  });

  it("filters on ?from and ?to inclusively", async () => {
    const repo = fakeRepo([
      tx({ id: txId(1), occurredAt: "2026-07-01T00:00:00.000Z" }),
      tx({ id: txId(2), occurredAt: "2026-07-15T00:00:00.000Z" }),
      tx({ id: txId(3), occurredAt: "2026-07-31T00:00:00.000Z" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-01T00:00:00.000Z&to=2026-07-15T00:00:00.000Z",
      headers: AUTH,
    });

    expect(res.json().transactions.map((t: Transaction) => t.id)).toEqual([txId(2), txId(1)]);
    await app.close();
  });

  it("accepts a plain calendar date as a bound", async () => {
    const repo = fakeRepo([tx({ occurredAt: "2026-07-18T09:30:00.000Z" })]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-18",
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toHaveLength(1);
    await app.close();
  });

  // A date-only `to` names a whole day, not its midnight. Parsed naively it
  // would be 00:00:00Z and the inclusive filter would drop the other 24 hours,
  // so a month's listing would silently lose its last day.
  it("includes the whole final day when ?to is a bare date", async () => {
    const repo = fakeRepo([
      tx({ id: txId(1), occurredAt: "2026-07-31T00:00:00.000Z" }),
      tx({ id: txId(2), occurredAt: "2026-07-31T12:00:00.000Z" }),
      tx({ id: txId(3), occurredAt: "2026-07-31T23:59:59.000Z" }),
      tx({ id: txId(4), occurredAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-01&to=2026-07-31",
      headers: AUTH,
    });

    expect(res.json().transactions.map((t: Transaction) => t.id)).toEqual([
      txId(3),
      txId(2),
      txId(1),
    ]);
    await app.close();
  });

  it("takes ?to as written when it carries a time", async () => {
    const repo = fakeRepo([
      tx({ id: txId(1), occurredAt: "2026-07-31T09:00:00.000Z" }),
      tx({ id: txId(2), occurredAt: "2026-07-31T18:00:00.000Z" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "GET",
      url: "/transactions?to=2026-07-31T12:00:00.000Z",
      headers: AUTH,
    });

    expect(res.json().transactions.map((t: Transaction) => t.id)).toEqual([txId(1)]);
    await app.close();
  });

  // The end-of-day widening must not turn an equal-date pair into "from > to".
  it("accepts from and to naming the same day", async () => {
    const repo = fakeRepo([tx({ occurredAt: "2026-07-18T09:30:00.000Z" })]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-18&to=2026-07-18",
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toHaveLength(1);
    await app.close();
  });

  it("rejects a from later than to instead of silently returning nothing", async () => {
    const app = appWith(fakeRepo());

    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-20&to=2026-07-01",
      headers: AUTH,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("from");
    await app.close();
  });

  it("pages with ?limit and hands back a cursor for the next page", async () => {
    const repo = fakeRepo([
      tx({ id: txId(1), occurredAt: "2026-07-03T00:00:00.000Z" }),
      tx({ id: txId(2), occurredAt: "2026-07-02T00:00:00.000Z" }),
      tx({ id: txId(3), occurredAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const app = appWith(repo);

    const first = await app.inject({ method: "GET", url: "/transactions?limit=2", headers: AUTH });
    expect(first.json().transactions.map((t: Transaction) => t.id)).toEqual([txId(1), txId(2)]);
    const cursor = first.json().nextCursor;
    expect(cursor).toBe(txId(2));

    const second = await app.inject({
      method: "GET",
      url: `/transactions?limit=2&cursor=${cursor}`,
      headers: AUTH,
    });
    expect(second.json().transactions.map((t: Transaction) => t.id)).toEqual([txId(3)]);
    // Exhausted — no further page.
    expect(second.json().nextCursor).toBeNull();
    await app.close();
  });

  it("filters on ?categoryId", async () => {
    const repo = fakeRepo([
      tx({ id: txId(1) }),
      tx({ id: txId(2), categoryId: "22222222-2222-2222-2222-222222222222" }),
    ]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "GET",
      url: `/transactions?categoryId=${CATEGORY_ID}`,
      headers: AUTH,
    });

    expect(res.json().transactions.map((t: Transaction) => t.id)).toEqual([txId(1)]);
    await app.close();
  });

  it.each([
    ["limit above the cap", "limit=5000", "limit"],
    ["a non-numeric limit", "limit=lots", "limit"],
    ["a zero limit", "limit=0", "limit"],
    ["a malformed cursor", "cursor=not-a-uuid", "cursor"],
    ["a malformed date", "from=nope", "from"],
  ])("rejects %s", async (_name, query, field) => {
    const app = appWith(fakeRepo());

    const res = await app.inject({ method: "GET", url: `/transactions?${query}`, headers: AUTH });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.map((d: { path: string }) => d.path)).toContain(field);
    await app.close();
  });

  it("rejects an unknown query parameter rather than ignoring it", async () => {
    const app = appWith(fakeRepo());
    const res = await app.inject({
      method: "GET",
      url: "/transactions?catgoryId=oops",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("requires authentication", async () => {
    const app = appWith(fakeRepo());
    const res = await app.inject({ method: "GET", url: "/transactions" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /transactions/:id", () => {
  it("returns the caller's transaction", async () => {
    const app = appWith(fakeRepo([tx()]));

    const res = await app.inject({ method: "GET", url: `/transactions/${TX_1}`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.id).toBe(TX_1);
    await app.close();
  });

  it("404s on another user's transaction", async () => {
    const app = appWith(fakeRepo([tx({ userId: "user-2" })]));

    const res = await app.inject({ method: "GET", url: `/transactions/${TX_1}`, headers: AUTH });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s on an id that does not exist", async () => {
    const app = appWith(fakeRepo());
    const res = await app.inject({
      method: "GET",
      url: `/transactions/${MISSING_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /transactions/:id", () => {
  it("updates the caller's transaction", async () => {
    const app = appWith(fakeRepo([tx()]));

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: { amountCents: 1_500, merchant: "Other Cafe" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toMatchObject({
      money: { amountCents: 1_500, currency: "EUR" },
      merchant: "Other Cafe",
    });
    await app.close();
  });

  it("clears an optional field on an explicit null", async () => {
    const app = appWith(fakeRepo([tx()]));

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: { merchant: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.merchant).toBeUndefined();
    await app.close();
  });

  it("404s on another user's transaction and leaves it untouched", async () => {
    const repo = fakeRepo([tx({ userId: "user-2" })]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: { merchant: "hijacked" },
    });

    expect(res.statusCode).toBe(404);
    expect(repo.rows[0]!.merchant).toBe("Cafe");
    await app.close();
  });

  it("rejects an empty patch", async () => {
    const app = appWith(fakeRepo([tx()]));

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("validates patched fields the same way as create", async () => {
    const repo = fakeRepo([tx()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: { amountCents: 9.99 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("amountCents");
    expect(repo.rows[0]!.money.amountCents).toBe(1_250);
    await app.close();
  });

  it("rejects a patch moving the row to an unknown category, before writing", async () => {
    const repo = fakeRepo([tx()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: { categoryId: OTHER_ID },
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows[0]!.categoryId).toBe(CATEGORY_ID);
    await app.close();
  });

  it("rejects a patch carrying userId", async () => {
    const repo = fakeRepo([tx()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      headers: AUTH,
      payload: { userId: "user-2" },
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows[0]!.userId).toBe(USER);
    await app.close();
  });

  it("requires authentication", async () => {
    const app = appWith(fakeRepo([tx()]));
    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${TX_1}`,
      payload: { amountCents: 1 },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("DELETE /transactions/:id", () => {
  it("removes the row and returns 204", async () => {
    const repo = fakeRepo([tx()]);
    const app = appWith(repo);

    const res = await app.inject({ method: "DELETE", url: `/transactions/${TX_1}`, headers: AUTH });

    expect(res.statusCode).toBe(204);
    expect(repo.rows).toEqual([]);
    await app.close();
  });

  it("404s on another user's transaction and leaves it in place", async () => {
    const repo = fakeRepo([tx({ userId: "user-2" })]);
    const app = appWith(repo);

    const res = await app.inject({ method: "DELETE", url: `/transactions/${TX_1}`, headers: AUTH });

    expect(res.statusCode).toBe(404);
    expect(repo.rows).toHaveLength(1);
    await app.close();
  });

  it("404s on an id that does not exist", async () => {
    const app = appWith(fakeRepo());
    const res = await app.inject({
      method: "DELETE",
      url: `/transactions/${MISSING_ID}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // Most HTTP clients set a JSON content-type on every request, body or not.
  it("accepts a JSON content-type with no body", async () => {
    const repo = fakeRepo([tx()]);
    const app = appWith(repo);

    const res = await app.inject({
      method: "DELETE",
      url: `/transactions/${TX_1}`,
      headers: { ...AUTH, "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("requires authentication", async () => {
    const repo = fakeRepo([tx()]);
    const app = appWith(repo);
    const res = await app.inject({ method: "DELETE", url: `/transactions/${TX_1}` });
    expect(res.statusCode).toBe(401);
    expect(repo.rows).toHaveLength(1);
    await app.close();
  });
});

describe("category validation", () => {
  it("rejects every create when no category is seeded", async () => {
    const repo = fakeRepo();
    const app = appWith(repo, acceptingAuth, emptyCategories);

    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: validBody,
    });

    expect(res.statusCode).toBe(400);
    expect(repo.rows).toEqual([]);
    await app.close();
  });
});
