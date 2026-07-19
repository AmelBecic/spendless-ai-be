import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { AuthDeps } from "../auth/plugin";
import type { Transaction } from "../domain/types";
import { createRepositories } from "../repositories";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { unusedLlm } from "../test/stubs";

// The endpoints against a real Postgres, with the real repositories behind them:
// the route tests prove the handlers given a well-behaved store, this proves the
// store is well-behaved — that the `userId` scoping actually reaches SQL, that
// the ordering and paging hold in the query planner rather than only in a fake,
// and that a rejected body leaves no row behind.
describe.skipIf(!hasTestDatabase)("transactions endpoints (integration)", () => {
  const testConfig: Env = {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
  };

  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  let categoryId: string;

  const authAs = (id: string): AuthDeps => ({
    verifier: { verify: async () => ({ id }) },
    profiles: { ensureProfile: async () => {} },
  });

  const appAs = (userId: string) =>
    buildApp({
      config: testConfig,
      db: { ping: async () => {} },
      auth: authAs(userId),
      llm: unusedLlm,
      repos: createRepositories(testDb()),
    });

  const AUTH = { authorization: "Bearer token" };

  const body = (over: Record<string, unknown> = {}) => ({
    amountCents: 1_250,
    currency: "EUR",
    categoryId,
    merchant: "Cafe",
    occurredAt: "2026-07-18T09:30:00.000Z",
    ...over,
  });

  /** Create a transaction as `userId`, failing loudly if the POST did not 201. */
  async function create(userId: string, over: Record<string, unknown> = {}): Promise<Transaction> {
    const app = appAs(userId);
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: body(over),
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    return res.json().transaction;
  }

  beforeEach(async () => {
    await resetDb();
    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const category = await testDb().category.create({ data: { key: "food", label: "Food" } });
    categoryId = category.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("round-trips a create through to the listing", async () => {
    const created = await create(userA, { merchant: "Bakery" });
    expect(created).toMatchObject({
      userId: userA,
      money: { amountCents: 1_250, currency: "EUR" },
      merchant: "Bakery",
      occurredAt: "2026-07-18T09:30:00.000Z",
    });

    const app = appAs(userA);
    const res = await app.inject({ method: "GET", url: "/transactions", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toEqual([created]);
    expect(res.json().nextCursor).toBeNull();
    await app.close();
  });

  it("a listing returns only the caller's rows", async () => {
    await create(userA, { merchant: "A's coffee" });
    await create(userB, { merchant: "B's lunch" });

    const app = appAs(userA);
    const res = await app.inject({ method: "GET", url: "/transactions", headers: AUTH });
    expect(res.json().transactions.map((t: Transaction) => t.merchant)).toEqual(["A's coffee"]);
    await app.close();
  });

  it("B cannot read, patch or delete A's transaction, and A's row is untouched", async () => {
    const mine = await create(userA, { merchant: "A's coffee" });

    const app = appAs(userB);
    const read = await app.inject({
      method: "GET",
      url: `/transactions/${mine.id}`,
      headers: AUTH,
    });
    const patched = await app.inject({
      method: "PATCH",
      url: `/transactions/${mine.id}`,
      headers: AUTH,
      payload: { merchant: "hijacked" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/transactions/${mine.id}`,
      headers: AUTH,
    });
    await app.close();

    expect(read.statusCode).toBe(404);
    expect(patched.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);

    const row = await testDb().transaction.findUnique({ where: { id: mine.id } });
    expect(row).toMatchObject({ userId: userA, merchant: "A's coffee" });
  });

  it("a cursor lifted from another user's page cannot surface their rows", async () => {
    const theirs = await create(userB, { merchant: "B's lunch" });
    await create(userA, { merchant: "A's coffee" });

    const app = appAs(userA);
    const res = await app.inject({
      method: "GET",
      url: `/transactions?cursor=${theirs.id}`,
      headers: AUTH,
    });
    await app.close();

    // `userId` is in the where regardless of the cursor, so the worst this can do
    // is page past nothing — never expose a row belonging to B.
    expect(res.statusCode).toBe(200);
    expect(res.json().transactions.every((t: Transaction) => t.userId === userA)).toBe(true);
  });

  it("a body carrying userId cannot reassign the row to another account", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: body({ userId: userB }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(await testDb().transaction.count()).toBe(0);
  });

  it("an invalid body never reaches the table", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: body({ amountCents: -1, currency: "EURO" }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["amountCents", "currency"]));
    expect(await testDb().transaction.count()).toBe(0);
  });

  // The AC's "integer cents on the wire and in storage". A float must not be
  // rounded into the int4 column behind the caller's back.
  it("rejects a float amount rather than rounding it into the column", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: body({ amountCents: 12.5 }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("amountCents");
    expect(await testDb().transaction.count()).toBe(0);
  });

  it("an unknown categoryId is a 400, not the foreign key's 500", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: body({ categoryId: "99999999-9999-9999-9999-999999999999" }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([{ path: "categoryId", message: "no such category" }]);
    expect(await testDb().transaction.count()).toBe(0);
  });

  // `amountCents` is a Prisma `Int` (Postgres int4). The schema's upper bound has
  // to be the column's, or an over-large amount passes validation and overflows
  // at the database as a 500. Both sides of the boundary are pinned here.
  it("accepts the largest amount the column holds and rejects one more", async () => {
    const ok = await create(userA, { amountCents: 2_147_483_647 });
    expect(ok.money.amountCents).toBe(2_147_483_647);

    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: AUTH,
      payload: body({ amountCents: 2_147_483_648 }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("amountCents");
    expect(await testDb().transaction.count()).toBe(1);
  });

  it("orders by occurredAt desc and pages deterministically", async () => {
    await create(userA, { occurredAt: "2026-07-01T00:00:00.000Z", merchant: "oldest" });
    await create(userA, { occurredAt: "2026-07-03T00:00:00.000Z", merchant: "newest" });
    await create(userA, { occurredAt: "2026-07-02T00:00:00.000Z", merchant: "middle" });

    const app = appAs(userA);
    const first = await app.inject({ method: "GET", url: "/transactions?limit=2", headers: AUTH });
    expect(first.json().transactions.map((t: Transaction) => t.merchant)).toEqual([
      "newest",
      "middle",
    ]);

    const cursor = first.json().nextCursor;
    expect(cursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/transactions?limit=2&cursor=${cursor}`,
      headers: AUTH,
    });
    await app.close();

    expect(second.json().transactions.map((t: Transaction) => t.merchant)).toEqual(["oldest"]);
    expect(second.json().nextCursor).toBeNull();
  });

  it("rows sharing a timestamp still page without loss or repetition", async () => {
    const at = "2026-07-05T12:00:00.000Z";
    await create(userA, { occurredAt: at, merchant: "one" });
    await create(userA, { occurredAt: at, merchant: "two" });
    await create(userA, { occurredAt: at, merchant: "three" });

    const app = appAs(userA);
    const seen: string[] = [];
    let cursor: string | null = null;
    // Walk the whole listing one row at a time; the id tiebreak is what keeps
    // this from looping or skipping when every occurredAt is identical.
    for (let page = 0; page < 5; page += 1) {
      const url: string = `/transactions?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      seen.push(...res.json().transactions.map((t: Transaction) => t.merchant));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }
    await app.close();

    expect(seen.sort()).toEqual(["one", "three", "two"]);
  });

  it("?from/?to bound the listing at the database", async () => {
    await create(userA, { occurredAt: "2026-06-30T23:59:59.000Z", merchant: "before" });
    await create(userA, { occurredAt: "2026-07-15T00:00:00.000Z", merchant: "inside" });
    await create(userA, { occurredAt: "2026-08-01T00:00:00.000Z", merchant: "after" });

    const app = appAs(userA);
    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z",
      headers: AUTH,
    });
    await app.close();

    expect(res.json().transactions.map((t: Transaction) => t.merchant)).toEqual(["inside"]);
  });

  // Against the real `lte` filter: a bare `to` date must cover its whole day,
  // or a calendar-month listing quietly under-reports the last one.
  it("?to as a bare date includes the whole final day", async () => {
    await create(userA, { occurredAt: "2026-07-31T12:00:00.000Z", merchant: "last day" });
    await create(userA, { occurredAt: "2026-08-01T00:00:00.000Z", merchant: "next month" });

    const app = appAs(userA);
    const res = await app.inject({
      method: "GET",
      url: "/transactions?from=2026-07-01&to=2026-07-31",
      headers: AUTH,
    });
    await app.close();

    expect(res.json().transactions.map((t: Transaction) => t.merchant)).toEqual(["last day"]);
  });

  it("DELETE removes the row", async () => {
    const mine = await create(userA);

    const app = appAs(userA);
    const res = await app.inject({
      method: "DELETE",
      url: `/transactions/${mine.id}`,
      headers: AUTH,
    });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(await testDb().transaction.count()).toBe(0);
  });

  it("PATCH clears an optional field on an explicit null", async () => {
    const mine = await create(userA, { merchant: "Cafe", note: "lunch" });

    const app = appAs(userA);
    const res = await app.inject({
      method: "PATCH",
      url: `/transactions/${mine.id}`,
      headers: AUTH,
      payload: { note: null },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.note).toBeUndefined();
    const row = await testDb().transaction.findUnique({ where: { id: mine.id } });
    expect(row?.note).toBeNull();
    expect(row?.merchant).toBe("Cafe");
  });

  it("a well-formed but unknown id is a 404", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "DELETE",
      url: "/transactions/99999999-9999-9999-9999-999999999999",
      headers: AUTH,
    });
    await app.close();

    expect(res.statusCode).toBe(404);
  });
});
