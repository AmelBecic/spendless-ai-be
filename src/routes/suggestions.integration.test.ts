import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { AuthDeps } from "../auth/plugin";
import type { LlmClient, LlmRequest } from "../agent/anthropic";
import { monthlyRateCents, periodDays } from "../agent/aggregate";
import { profilePeriod } from "../agent/profile-refresh";
import { TRIM_RATES } from "../agent/suggest";
import { createRepositories } from "../repositories";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { nth } from "../test/stubs";

// The suggestion loop against a real Postgres. The route tests prove the handler
// given a well-behaved store; this proves what only the database can show — that
// a computed saving survives the round trip as integer cents, that every figure
// traces back to a stat the API itself reports, that a citation the model
// invented never becomes a row, and that no part of it crosses between users.
describe.skipIf(!hasTestDatabase)("/suggestions (integration)", () => {
  const testConfig: Env = {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
  };

  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  const GYM_CENTS = 4000;

  let foodId: string;
  let fitnessId: string;
  let gymId: string;

  const authAs = (id: string): AuthDeps => ({
    verifier: { verify: async () => ({ id }) },
    profiles: { ensureProfile: async () => {} },
  });

  const requests: LlmRequest<unknown>[] = [];

  /** Whatever proposals a test asks for, recorded so model calls are countable. */
  let proposals: unknown[] = [];

  const llm: LlmClient = {
    complete: <T>(request: LlmRequest<T>) => {
      requests.push(request as LlmRequest<unknown>);
      return Promise.resolve({
        data: { suggestions: proposals } as unknown as T,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          estimatedCostUsd: 0,
        },
      });
    },
  };

  const appAs = (userId: string) =>
    buildApp({
      config: testConfig,
      db: { ping: async () => {} },
      auth: authAs(userId),
      llm,
      repos: createRepositories(testDb()),
    });

  const AUTH = { authorization: "Bearer token" };

  async function call(
    userId: string,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
  ) {
    const app = appAs(userId);
    const res = await app.inject({ method, url, headers: AUTH, ...(payload ? { payload } : {}) });
    await app.close();
    return res;
  }

  const refresh = (userId: string) => call(userId, "POST", "/suggestions/refresh");
  const list = (userId: string) => call(userId, "GET", "/suggestions");
  const stats = (userId: string) => call(userId, "GET", "/stats");

  const today = () => new Date().toISOString().slice(0, 10);

  const spend = (userId: string, amountCents: number, categoryId: string) =>
    testDb().transaction.create({
      data: {
        userId,
        amountCents,
        currency: "EUR",
        categoryId,
        occurredAt: new Date(`${today()}T09:00:00.000Z`),
      },
    });

  const trim = (categoryId: string) => ({
    kind: "trim_category",
    targetId: categoryId,
    lever: "moderate",
    text: "Cook at home two more evenings a week.",
    rationale: "Food is your largest discretionary category.",
  });

  const cancel = (expenseId: string) => ({
    kind: "cancel_recurring",
    targetId: expenseId,
    lever: "modest",
    text: "Cancel the gym membership you are not using.",
    rationale: "A recurring charge with no matching activity.",
  });

  beforeEach(async () => {
    await resetDb();
    requests.length = 0;
    proposals = [];

    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);

    const food = await testDb().category.create({ data: { key: "food", label: "Food" } });
    foodId = food.id;
    const fitness = await testDb().category.create({
      data: { key: "fitness", label: "Fitness" },
    });
    fitnessId = fitness.id;

    // Its own category, so a trim on food is visibly priced against food's
    // transactions rather than against a total the gym's proration inflates.
    const gym = await testDb().fixedExpense.create({
      data: {
        userId: userA,
        label: "Gym",
        categoryId: fitnessId,
        amountCents: GYM_CENTS,
        currency: "EUR",
        cadence: "monthly",
        active: true,
      },
    });
    gymId = gym.id;
  });

  afterAll(disconnectTestDb);

  it("persists a cancellation priced at the commitment's own monthly amount", async () => {
    await spend(userA, 20000, foodId);
    proposals = [cancel(gymId)];

    const res = await refresh(userA);
    expect(res.statusCode).toBe(200);

    // Hand-computed, and independent of today's date: a monthly commitment is
    // worth exactly its own amount per month.
    const rows = await testDb().suggestion.findMany({ where: { userId: userA } });
    expect(rows).toHaveLength(1);
    expect(nth(rows, 0).estMonthlySavingsCents).toBe(GYM_CENTS);
    expect(nth(rows, 0).currency).toBe("EUR");
  });

  it("prices a trim from a figure /stats itself reports", async () => {
    await spend(userA, 20000, foodId);
    proposals = [trim(foodId)];

    await refresh(userA);

    // The figure has to trace to a stat the API will show the user — not to an
    // intermediate this test computed for its own convenience. Food is the only
    // transaction spend, so its trimmable base is `discretionaryTotal`.
    const body = (await stats(userA)).json();
    expect(body.stats.discretionaryTotal.amountCents).toBe(20000);

    const period = profilePeriod(new Date());
    const expected = Math.round(
      monthlyRateCents(body.stats.discretionaryTotal.amountCents, periodDays(period)) *
        TRIM_RATES.moderate,
    );

    const rows = await testDb().suggestion.findMany({ where: { userId: userA } });
    expect(nth(rows, 0).estMonthlySavingsCents).toBe(expected);
    expect(Number.isInteger(nth(rows, 0).estMonthlySavingsCents)).toBe(true);
  });

  it("does not price a trim against commitments folded into the category", async () => {
    // Food carries no commitment, fitness carries the gym. A trim on fitness has
    // nothing discretionary behind it, so it must be dropped rather than priced
    // off the gym's prorated share of that category.
    await spend(userA, 20000, foodId);
    proposals = [trim(fitnessId)];

    await refresh(userA);

    const body = (await stats(userA)).json();
    const fitness = body.stats.byCategory.find(
      (entry: { categoryId: string }) => entry.categoryId === fitnessId,
    );
    // /stats does report spend there — it is recurring, and none of it trimmable.
    expect(fitness.total.amountCents).toBeGreaterThan(0);
    expect(await testDb().suggestion.count({ where: { userId: userA } })).toBe(0);
  });

  it("cites only refs that name something real", async () => {
    await spend(userA, 20000, foodId);
    proposals = [trim(foodId), cancel(gymId)];

    await refresh(userA);

    const res = await list(userA);
    const suggestions = res.json().suggestions as { sourceRefs: string[] }[];
    expect(suggestions).toHaveLength(2);

    const categoryIds = new Set(
      (await testDb().category.findMany()).map((row) => `category:${row.id}`),
    );
    const expenseIds = new Set(
      (await testDb().fixedExpense.findMany()).map((row) => `fixedExpense:${row.id}`),
    );
    const statRefs = new Set(["stat:discretionaryTotal", "stat:recurringTotal"]);

    for (const suggestion of suggestions) {
      expect(suggestion.sourceRefs.length).toBeGreaterThan(0);
      for (const ref of suggestion.sourceRefs) {
        const real = categoryIds.has(ref) || expenseIds.has(ref) || statRefs.has(ref);
        expect(real, `${ref} names nothing that exists`).toBe(true);
      }
    }
  });

  it("never persists a suggestion citing a target the user does not have", async () => {
    await spend(userA, 20000, foodId);
    // A category id that exists nowhere, and user-A's own gym cited by a user
    // who does not own it — both must die before the insert.
    proposals = [trim("99999999-9999-4999-8999-999999999999"), cancel(gymId)];

    await refresh(userB);

    const rows = await testDb().suggestion.findMany({ where: { userId: userB } });
    expect(rows).toHaveLength(0);
  });

  it("keeps one user's suggestions out of another's feed", async () => {
    await spend(userA, 20000, foodId);
    await spend(userB, 500, foodId);

    proposals = [cancel(gymId)];
    await refresh(userA);

    const res = await list(userB);
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestions).toHaveLength(0);
  });

  it("refuses to let one user flip another's suggestion", async () => {
    await spend(userA, 20000, foodId);
    proposals = [cancel(gymId)];
    await refresh(userA);

    const rows = await testDb().suggestion.findMany({ where: { userId: userA } });
    const id = nth(rows, 0).id;

    const res = await call(userB, "PATCH", `/suggestions/${id}`, { status: "dismissed" });
    expect(res.statusCode).toBe(404);

    // ...and the row is untouched, not merely unreported.
    const after = await testDb().suggestion.findUnique({ where: { id } });
    expect(after?.status).toBe("new");
  });

  it("round-trips a dismissal", async () => {
    await spend(userA, 20000, foodId);
    proposals = [cancel(gymId)];
    await refresh(userA);

    const rows = await testDb().suggestion.findMany({ where: { userId: userA } });
    const id = nth(rows, 0).id;

    const res = await call(userA, "PATCH", `/suggestions/${id}`, { status: "dismissed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestion.status).toBe("dismissed");

    const after = await testDb().suggestion.findUnique({ where: { id } });
    expect(after?.status).toBe("dismissed");
  });

  it("does not pay for a second model call on the same day", async () => {
    await spend(userA, 20000, foodId);
    proposals = [cancel(gymId)];

    await refresh(userA);
    const second = await refresh(userA);

    expect(second.statusCode).toBe(200);
    expect(second.json().suggestions).toHaveLength(1);
    // One refresh, one completion — the day's set short-circuits the second.
    expect(requests).toHaveLength(1);
    expect(await testDb().suggestion.count({ where: { userId: userA } })).toBe(1);
  });

  it("writes one set when two refreshes race", async () => {
    await spend(userA, 20000, foodId);
    proposals = [trim(foodId), cancel(gymId)];

    // Both pass the fast-path check before either inserts — the window the
    // per-user row lock exists to close. Both still pay for a completion; that
    // half is a rate limit's job, not this one's.
    const [first, second] = await Promise.all([refresh(userA), refresh(userA)]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Two proposals, one set — not four rows.
    expect(await testDb().suggestion.count({ where: { userId: userA } })).toBe(2);
    // ...and the loser is handed the winner's rows rather than an empty list.
    expect(first.json().suggestions).toHaveLength(2);
    expect(second.json().suggestions).toHaveLength(2);
  });

  it("ranks the biggest saving first", async () => {
    // Large enough that the trim outranks the gym on every day of the month —
    // the monthly rate shrinks as the month-to-date window lengthens, and a
    // fixture that only just wins in July would flip on the 31st.
    await spend(userA, 100000, foodId);
    proposals = [cancel(gymId), trim(foodId)];

    await refresh(userA);

    const res = await list(userA);
    const suggestions = res.json().suggestions as {
      estMonthlySavings: { amountCents: number };
    }[];
    expect(suggestions.length).toBeGreaterThan(1);
    // The trim on 1,000.00 of food outweighs a 40.00 gym membership, whatever
    // order the model listed them in or the rows were inserted.
    expect(nth(suggestions, 0).estMonthlySavings.amountCents).toBeGreaterThan(
      nth(suggestions, 1).estMonthlySavings.amountCents,
    );
  });

  it("rejects every endpoint without a token", async () => {
    const app = buildApp({
      config: testConfig,
      db: { ping: async () => {} },
      auth: {
        verifier: { verify: () => Promise.reject(new Error("no token")) },
        profiles: { ensureProfile: async () => {} },
      },
      llm,
      repos: createRepositories(testDb()),
    });

    expect((await app.inject({ method: "GET", url: "/suggestions" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/suggestions/refresh" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/suggestions/${gymId}`,
          payload: { status: "dismissed" },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
});
