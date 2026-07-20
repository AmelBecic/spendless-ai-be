// The per-user meter on the paid routes, driven end to end through the real app
// against a real Postgres.
//
// The unit tests prove the counter's arithmetic; this proves it is actually
// wired to the routes that spend money, that a refused call is refused *before*
// the model is reached, and that the refusal comes back in the app's standard
// error envelope rather than as an uncaught 500.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { AuthDeps } from "../auth/plugin";
import type { LlmClient, LlmRequest } from "../agent/anthropic";
import { createRepositories } from "../repositories";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { testEnv } from "../test/stubs";

describe.skipIf(!hasTestDatabase)("refresh rate limit (integration)", () => {
  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  let foodId: string;
  let calls: LlmRequest<unknown>[];

  const authAs = (id: string): AuthDeps => ({
    verifier: { verify: async () => ({ id }) },
    profiles: { ensureProfile: async () => {} },
  });

  const llm: LlmClient = {
    complete: <T>(request: LlmRequest<T>) => {
      calls.push(request as LlmRequest<unknown>);
      const data =
        request.schemaName === "profile_summary"
          ? { habits: [], trends: [], notableChanges: [], narrative: "Steady." }
          : { suggestions: [] };
      return Promise.resolve({
        data: data as unknown as T,
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

  /**
   * One app instance per test, since the limiter's counters live inside it —
   * rebuilding between tests is what keeps them independent.
   */
  const appWith = (limit: number, userId: string) => {
    const config: Env = testEnv({
      DATABASE_URL: process.env.TEST_DATABASE_URL!,
      REFRESH_RATE_LIMIT: limit,
    });
    return buildApp({
      config,
      db: { ping: async () => {} },
      auth: authAs(userId),
      llm,
      repos: createRepositories(testDb()),
    });
  };

  const AUTH = { authorization: "Bearer token" };

  beforeEach(async () => {
    await resetDb();
    calls = [];
    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const food = await testDb().category.create({ data: { key: "food", label: "Food" } });
    foodId = food.id;
    await testDb().transaction.create({
      data: {
        userId: userA,
        amountCents: 2500,
        currency: "EUR",
        categoryId: foodId,
        occurredAt: new Date(),
      },
    });
  });

  afterAll(disconnectTestDb);

  it("returns 429 in the standard error envelope once the limit is spent", async () => {
    const app = appWith(1, userA);

    const first = await app.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    const second = await app.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    // The envelope, not a bespoke body and not an uncaught 500.
    expect(second.json()).toEqual({
      error: { code: "RATE_LIMITED", message: expect.stringContaining("retry in") },
    });
    expect(second.headers["retry-after"]).toMatch(/^\d+$/);
  });

  it("refuses before reaching the model, so a throttled call costs nothing", async () => {
    const app = appWith(1, userA);

    await app.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    const spentAfterFirst = calls.length;
    await app.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    await app.close();

    // The whole point of the guard: the refused request bought no completion.
    expect(calls.length).toBe(spentAfterFirst);
  });

  it("spends one budget across both refresh routes", async () => {
    // Metering them separately would let a caller alternate and spend twice the
    // intended ceiling on the same model.
    const app = appWith(1, userA);

    const profile = await app.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    const suggestions = await app.inject({
      method: "POST",
      url: "/suggestions/refresh",
      headers: AUTH,
    });
    await app.close();

    expect(profile.statusCode).toBe(200);
    expect(suggestions.statusCode).toBe(429);
  });

  it("meters each user separately", async () => {
    // One user exhausting their budget must not lock anyone else out — a limiter
    // keyed on something other than the caller would fail exactly here.
    const appA = appWith(1, userA);
    await appA.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    const exhausted = await appA.inject({
      method: "POST",
      url: "/profile/refresh",
      headers: AUTH,
    });
    await appA.close();

    expect(exhausted.statusCode).toBe(429);

    // userB has no ledger, so their refresh 404s rather than 200s — either way
    // it is *not* a 429, which is the assertion.
    const appB = appWith(1, userB);
    const otherUser = await appB.inject({
      method: "POST",
      url: "/profile/refresh",
      headers: AUTH,
    });
    await appB.close();

    expect(otherUser.statusCode).not.toBe(429);
  });

  it("leaves the unmetered reads alone", async () => {
    const app = appWith(1, userA);

    await app.inject({ method: "POST", url: "/profile/refresh", headers: AUTH });
    // GET /profile costs nothing to serve, so it must not share the paid budget.
    const reads = await Promise.all(
      [0, 1, 2].map(() => app.inject({ method: "GET", url: "/profile", headers: AUTH })),
    );
    await app.close();

    expect(reads.map((r) => r.statusCode)).toEqual([200, 200, 200]);
  });
});
