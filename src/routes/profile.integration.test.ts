import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { AuthDeps } from "../auth/plugin";
import type { LlmClient, LlmRequest } from "../agent/anthropic";
import { MODEL } from "../agent/anthropic";
import { createRepositories } from "../repositories";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { nth, testEnv } from "../test/stubs";

// The profiling loop against a real Postgres. The route tests prove the handler
// given a well-behaved store; this proves the parts only the database can show —
// that a summary round-trips through the Json column intact, that the upsert
// really is one row per user per day, that a second refresh reads only the new
// activity, and that neither endpoint can be pointed at another user's profile.
describe.skipIf(!hasTestDatabase)("/profile (integration)", () => {
  const testConfig: Env = testEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL! });

  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  let foodId: string;

  const authAs = (id: string): AuthDeps => ({
    verifier: { verify: async () => ({ id }) },
    profiles: { ensureProfile: async () => {} },
  });

  /** Records what each refresh sent, so the incremental read is observable. */
  const requests: LlmRequest<unknown>[] = [];

  const llm: LlmClient = {
    complete: <T>(request: LlmRequest<T>) => {
      requests.push(request as LlmRequest<unknown>);
      return Promise.resolve({
        data: {
          habits: ["Buys lunch out"],
          trends: ["Food spend rising"],
          notableChanges: ["Joined a gym"],
          narrative: "Your spending was steady this month.",
        } as unknown as T,
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

  async function call(userId: string, method: "GET" | "POST", url: string) {
    const app = appAs(userId);
    const res = await app.inject({ method, url, headers: AUTH });
    await app.close();
    return res;
  }

  const refresh = (userId: string) => call(userId, "POST", "/profile/refresh");
  const read = (userId: string) => call(userId, "GET", "/profile");

  const today = () => new Date().toISOString().slice(0, 10);

  const spend = (userId: string, amountCents: number, occurredAt: string) =>
    testDb().transaction.create({
      data: {
        userId,
        amountCents,
        currency: "EUR",
        categoryId: foodId,
        occurredAt: new Date(occurredAt),
      },
    });

  beforeEach(async () => {
    await resetDb();
    requests.length = 0;
    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const food = await testDb().category.create({ data: { key: "food", label: "Food" } });
    foodId = food.id;
  });

  afterAll(disconnectTestDb);

  it("persists a summary that round-trips through the Json column", async () => {
    await spend(userA, 2500, `${today()}T09:00:00.000Z`);

    const created = await refresh(userA);
    expect(created.statusCode).toBe(200);

    const fetched = await read(userA);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().profile).toMatchObject({
      userId: userA,
      asOfDate: today(),
      model: MODEL,
      narrative: "Your spending was steady this month.",
      summary: {
        habits: ["Buys lunch out"],
        trends: ["Food spend rising"],
        notableChanges: ["Joined a gym"],
      },
    });
  });

  it("rewrites the day's summary instead of accumulating rows", async () => {
    await spend(userA, 2500, `${today()}T09:00:00.000Z`);

    await refresh(userA);
    await refresh(userA);

    const rows = await testDb().profileSummary.findMany({ where: { userId: userA } });
    expect(rows).toHaveLength(1);
  });

  it("reads only new activity on a second refresh", async () => {
    // Yesterday's spend lands in the first pass; today's is all the second
    // should see, since the first summary is dated today.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await spend(userA, 1000, `${yesterday}T09:00:00.000Z`);

    await refresh(userA);
    expect(nth(requests, 0).input).toContain(yesterday);

    await spend(userA, 3000, `${today()}T10:00:00.000Z`);
    await refresh(userA);

    expect(nth(requests, 1).input).toContain(today());
    // Already folded into the first summary — reprocessing it is the cost the
    // incremental loop exists to avoid.
    expect(nth(requests, 1).input).not.toContain(yesterday);
    // ...and the previous summary is what carries that history forward instead.
    expect(nth(requests, 1).input).toContain("Buys lunch out");
  });

  it("scopes GET /profile to the caller", async () => {
    await spend(userA, 2500, `${today()}T09:00:00.000Z`);
    await refresh(userA);

    // user-B has never refreshed; user-A's row must not surface for them.
    const res = await read(userB);
    expect(res.statusCode).toBe(404);
  });

  it("scopes POST /profile/refresh to the caller", async () => {
    await spend(userA, 999999, `${today()}T09:00:00.000Z`);
    await spend(userB, 2500, `${today()}T09:00:00.000Z`);

    await refresh(userB);

    const rows = await testDb().profileSummary.findMany();
    expect(rows).toHaveLength(1);
    expect(nth(rows, 0).userId).toBe(userB);
    // user-A's 9,999.99 never entered user-B's payload.
    expect(nth(requests, 0).input).not.toContain("9999.99");
  });

  it("rejects both endpoints without a token", async () => {
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

    expect((await app.inject({ method: "GET", url: "/profile" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/profile/refresh" })).statusCode).toBe(401);
    await app.close();
  });
});
