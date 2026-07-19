import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { AuthDeps } from "../auth/plugin";
import { createRepositories } from "../repositories";
import { MAX_PAGE_SIZE } from "../repositories/shared";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";

// /stats against a real Postgres with the real repositories behind it. The route
// tests prove the arithmetic given a well-behaved store; this proves the reads
// that feed it — that the period filter is applied in SQL, that the cursor walk
// really does collect more than one page, and that the `userId` scoping holds so
// one user's total can never absorb another's spend.
describe.skipIf(!hasTestDatabase)("GET /stats (integration)", () => {
  const testConfig: Env = {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
  };

  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  let foodId: string;
  let healthId: string;

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

  /** The seven-day window the aggregation's unit tests work through by hand. */
  const WINDOW = "from=2026-07-06&to=2026-07-12";

  async function statsFor(userId: string, query = WINDOW) {
    const app = appAs(userId);
    const res = await app.inject({ method: "GET", url: `/stats?${query}`, headers: AUTH });
    await app.close();
    return res;
  }

  const spend = (userId: string, amountCents: number, occurredAt: string, categoryId?: string) =>
    testDb().transaction.create({
      data: {
        userId,
        amountCents,
        currency: "EUR",
        categoryId: categoryId ?? foodId,
        occurredAt: new Date(occurredAt),
      },
    });

  beforeEach(async () => {
    await resetDb();
    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const [food, health] = await Promise.all([
      testDb().category.create({ data: { key: "food", label: "Food" } }),
      testDb().category.create({ data: { key: "health", label: "Health" } }),
    ]);
    foodId = food.id;
    healthId = health.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("totals real rows over the period, recurring and discretionary apart", async () => {
    await spend(userA, 2500, "2026-07-07T12:00:00.000Z");
    await spend(userA, 1500, "2026-07-09T12:00:00.000Z");
    // Previous comparable window (2026-06-29..2026-07-05).
    await spend(userA, 3000, "2026-07-02T12:00:00.000Z");
    await createRepositories(testDb()).expenses.create(userA, {
      label: "Gym",
      categoryId: healthId,
      amountCents: 5000,
      currency: "EUR",
      cadence: "weekly",
    });

    const res = await statsFor(userA);
    expect(res.statusCode).toBe(200);

    const { stats } = res.json();
    expect(stats).toMatchObject({
      periodStart: "2026-07-06",
      periodEnd: "2026-07-12",
      currency: "EUR",
      discretionaryTotal: { amountCents: 4000, currency: "EUR" },
      // A weekly expense over exactly seven days is charged in full.
      recurringTotal: { amountCents: 5000, currency: "EUR" },
      total: { amountCents: 9000, currency: "EUR" },
      // Current 9000 against previous 3000 + the same 5000 gym = 8000.
      momDeltaCents: 1000,
    });
    expect(stats.byCategory).toEqual([
      { categoryId: healthId, total: { amountCents: 5000, currency: "EUR" }, share: 0.5556 },
      { categoryId: foodId, total: { amountCents: 4000, currency: "EUR" }, share: 0.4444 },
    ]);
  });

  it("filters the period in SQL, excluding rows on either side", async () => {
    await spend(userA, 100, "2026-07-05T23:59:59.000Z");
    await spend(userA, 2500, "2026-07-06T00:00:00.000Z");
    // Late on the last day: an `lte` against bare midnight would drop this.
    await spend(userA, 700, "2026-07-12T23:30:00.000Z");
    await spend(userA, 900, "2026-07-13T00:00:01.000Z");

    const res = await statsFor(userA);
    expect(res.json().stats.total).toEqual({ amountCents: 3200, currency: "EUR" });
  });

  it("walks the cursor past the page size to total the whole period", async () => {
    const rows = MAX_PAGE_SIZE + 50;
    await testDb().transaction.createMany({
      data: Array.from({ length: rows }, () => ({
        userId: userA,
        amountCents: 100,
        currency: "EUR",
        categoryId: foodId,
        occurredAt: new Date("2026-07-08T12:00:00.000Z"),
      })),
    });

    const res = await statsFor(userA);
    // A handler reading a single page would report MAX_PAGE_SIZE * 100.
    expect(res.json().stats.total).toEqual({ amountCents: rows * 100, currency: "EUR" });
  });

  it("never absorbs another user's spend", async () => {
    await spend(userA, 2500, "2026-07-07T12:00:00.000Z");
    await spend(userB, 999999, "2026-07-08T12:00:00.000Z");
    await createRepositories(testDb()).expenses.create(userB, {
      label: "Rent",
      categoryId: healthId,
      amountCents: 800000,
      currency: "EUR",
      cadence: "monthly",
    });

    expect((await statsFor(userA)).json().stats.total).toEqual({
      amountCents: 2500,
      currency: "EUR",
    });
    expect((await statsFor(userB)).json().stats.discretionaryTotal).toEqual({
      amountCents: 999999,
      currency: "EUR",
    });
  });

  it("reports zeroes for a user with no ledger at all", async () => {
    const res = await statsFor(userA);
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toMatchObject({
      total: { amountCents: 0, currency: "EUR" },
      byCategory: [],
      momDeltaCents: 0,
    });
  });

  it("refuses to total a ledger that mixes currencies", async () => {
    await spend(userA, 2500, "2026-07-07T12:00:00.000Z");
    await testDb().transaction.create({
      data: {
        userId: userA,
        amountCents: 1000,
        currency: "USD",
        categoryId: foodId,
        occurredAt: new Date("2026-07-08T12:00:00.000Z"),
      },
    });

    const res = await statsFor(userA);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("MIXED_CURRENCY");
  });

  it("is deterministic — two identical requests return identical stats", async () => {
    await spend(userA, 2500, "2026-07-07T12:00:00.000Z");
    await spend(userA, 4000, "2026-07-09T12:00:00.000Z", healthId);

    const [first, second] = await Promise.all([statsFor(userA), statsFor(userA)]);
    expect(first.json()).toEqual(second.json());
  });
});
