import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { AuthDeps } from "../auth/plugin";
import type { FixedExpense } from "../domain/types";
import { createRepositories } from "../repositories";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";

// The endpoints against a real Postgres, with the real repositories behind them:
// the route tests prove the handlers given a well-behaved store, this proves the
// store is well-behaved — that the `userId` scoping actually reaches SQL, and
// that a rejected body leaves no row behind.
describe.skipIf(!hasTestDatabase)("fixed expenses endpoints (integration)", () => {
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
      repos: createRepositories(testDb()),
    });

  const AUTH = { authorization: "Bearer token" };

  const body = (over: Record<string, unknown> = {}) => ({
    label: "Rent",
    categoryId,
    amountCents: 120_000,
    currency: "EUR",
    cadence: "monthly",
    ...over,
  });

  /** Create an expense as `userId` and return it, failing loudly if the POST did not 201. */
  async function create(userId: string, over: Record<string, unknown> = {}): Promise<FixedExpense> {
    const app = appAs(userId);
    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: body(over),
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    return res.json().fixedExpense;
  }

  beforeEach(async () => {
    await resetDb();
    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const category = await testDb().category.create({ data: { key: "housing", label: "Housing" } });
    categoryId = category.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("round-trips a create through to the listing", async () => {
    const created = await create(userA, { label: "Gym" });
    expect(created).toMatchObject({
      userId: userA,
      label: "Gym",
      money: { amountCents: 120_000, currency: "EUR" },
      cadence: "monthly",
      active: true,
    });

    const app = appAs(userA);
    const res = await app.inject({ method: "GET", url: "/fixed-expenses", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().fixedExpenses).toEqual([created]);
    await app.close();
  });

  it("a listing returns only the caller's rows", async () => {
    await create(userA, { label: "A's gym" });
    await create(userB, { label: "B's rent" });

    const app = appAs(userA);
    const res = await app.inject({ method: "GET", url: "/fixed-expenses", headers: AUTH });
    expect(res.json().fixedExpenses.map((e: FixedExpense) => e.label)).toEqual(["A's gym"]);
    await app.close();
  });

  it("B cannot patch or delete A's expense, and A's row is untouched", async () => {
    const mine = await create(userA, { label: "A's rent" });

    const app = appAs(userB);
    const patched = await app.inject({
      method: "PATCH",
      url: `/fixed-expenses/${mine.id}`,
      headers: AUTH,
      payload: { label: "hijacked" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/fixed-expenses/${mine.id}`,
      headers: AUTH,
    });
    await app.close();

    expect(patched.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);

    const row = await testDb().fixedExpense.findUnique({ where: { id: mine.id } });
    expect(row).toMatchObject({ userId: userA, label: "A's rent", active: true });
  });

  it("a body carrying userId cannot reassign the row to another account", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: body({ userId: userB }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(await testDb().fixedExpense.count()).toBe(0);
  });

  it("an invalid body never reaches the table", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: body({ amountCents: -1, cadence: "daily" }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["amountCents", "cadence"]));
    expect(await testDb().fixedExpense.count()).toBe(0);
  });

  it("an unknown categoryId is a 400, not the foreign key's 500", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: body({ categoryId: "99999999-9999-9999-9999-999999999999" }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([{ path: "categoryId", message: "no such category" }]);
    expect(await testDb().fixedExpense.count()).toBe(0);
  });

  it("DELETE deactivates without removing the row", async () => {
    const mine = await create(userA);

    const app = appAs(userA);
    const res = await app.inject({
      method: "DELETE",
      url: `/fixed-expenses/${mine.id}`,
      headers: AUTH,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().fixedExpense.active).toBe(false);
    // Still there — historical stats read deactivated commitments.
    const row = await testDb().fixedExpense.findUnique({ where: { id: mine.id } });
    expect(row).toMatchObject({ active: false });
  });

  it("?active filters the listing", async () => {
    const live = await create(userA, { label: "Live" });
    const cancelled = await create(userA, { label: "Cancelled" });

    const app = appAs(userA);
    await app.inject({ method: "DELETE", url: `/fixed-expenses/${cancelled.id}`, headers: AUTH });

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
    await app.close();

    expect(active.json().fixedExpenses.map((e: FixedExpense) => e.id)).toEqual([live.id]);
    expect(inactive.json().fixedExpenses.map((e: FixedExpense) => e.id)).toEqual([cancelled.id]);
  });

  // `amountCents` is a Prisma `Int` (Postgres int4). The schema's upper bound has
  // to be the column's, or an over-large amount passes validation and overflows
  // at the database as a 500. Both sides of the boundary are pinned here so a
  // change to either one fails loudly.
  it("accepts the largest amount the column holds and rejects one more", async () => {
    const ok = await create(userA, { amountCents: 2_147_483_647 });
    expect(ok.money.amountCents).toBe(2_147_483_647);

    const app = appAs(userA);
    const res = await app.inject({
      method: "POST",
      url: "/fixed-expenses",
      headers: AUTH,
      payload: body({ amountCents: 2_147_483_648 }),
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe("amountCents");
    expect(await testDb().fixedExpense.count()).toBe(1);
  });

  it("a well-formed but unknown id is a 404", async () => {
    const app = appAs(userA);
    const res = await app.inject({
      method: "DELETE",
      url: "/fixed-expenses/99999999-9999-9999-9999-999999999999",
      headers: AUTH,
    });
    await app.close();

    expect(res.statusCode).toBe(404);
  });
});
