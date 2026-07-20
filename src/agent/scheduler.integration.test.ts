// The daily refresh against a real Postgres, with the real repositories behind
// it. The unit tests prove the job's control flow against fakes; this proves the
// part only the database can show — that the "has anything happened?" probe is a
// real query over real rows, so the skip that saves the money is driven by what
// is actually stored rather than by a fake that agreed with it.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { LlmClient, LlmRequest } from "./anthropic";
import { createRepositories } from "../repositories";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { runDailyRefresh, type DailyRefreshDeps } from "./scheduler";

describe.skipIf(!hasTestDatabase)("daily refresh (integration)", () => {
  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  let foodId: string;

  /** Every model call the pass made — an empty log is the cost assertion. */
  let calls: LlmRequest<unknown>[];

  const llm: LlmClient = {
    complete: <T>(request: LlmRequest<T>) => {
      calls.push(request as LlmRequest<unknown>);
      const data =
        request.schemaName === "profile_summary"
          ? { habits: ["Eats out"], trends: [], notableChanges: [], narrative: "Steady." }
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

  const deps = (): DailyRefreshDeps => ({
    llm,
    ...createRepositories(testDb()),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const spend = (userId: string, amountCents: number) =>
    testDb().transaction.create({
      data: {
        userId,
        amountCents,
        currency: "EUR",
        categoryId: foodId,
        occurredAt: new Date(),
      },
    });

  beforeEach(async () => {
    await resetDb();
    calls = [];
    const repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const food = await testDb().category.create({ data: { key: "food", label: "Food" } });
    foodId = food.id;
  });

  afterAll(disconnectTestDb);

  it("buys no completion for a user whose ledger has not moved since the last pass", async () => {
    await spend(userA, 2500);

    // First pass: there is new activity, so it runs and writes a summary.
    const first = await runDailyRefresh(deps(), new Date());
    expect(first).toMatchObject({ refreshed: 1 });
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Second pass on an unchanged ledger, on a later day so the per-day claim is
    // not what does the skipping — the activity probe has to be.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const second = await runDailyRefresh(deps(), tomorrow);

    expect(second).toMatchObject({ scanned: 2, refreshed: 0, skipped: 2, failed: 0 });
    expect(calls.length).toBe(afterFirst);
  });

  it("refreshes again once the user records something new", async () => {
    await spend(userA, 2500);
    await runDailyRefresh(deps(), new Date());
    const afterFirst = calls.length;

    // A backdated entry would sit outside an `occurredAt` window, so this also
    // pins that the probe reads `createdAt` — the column that says "newly typed
    // in" rather than "recently happened".
    await testDb().transaction.create({
      data: {
        userId: userA,
        amountCents: 900,
        currency: "EUR",
        categoryId: foodId,
        occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const second = await runDailyRefresh(deps(), tomorrow);

    expect(second).toMatchObject({ refreshed: 1 });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it("skips an account that has never recorded anything", async () => {
    // Both users are provisioned but empty. A pass over a fresh signup list must
    // cost nothing at all.
    const result = await runDailyRefresh(deps(), new Date());

    expect(result).toMatchObject({ scanned: 2, refreshed: 0, skipped: 2 });
    expect(calls).toEqual([]);
  });

  it("records the pass so a second run the same day pays nothing", async () => {
    await spend(userB, 4000);

    await runDailyRefresh(deps(), new Date());
    const afterFirst = calls.length;
    // Same day, same ledger — a cron firing twice must not re-buy it.
    await runDailyRefresh(deps(), new Date());

    expect(calls.length).toBe(afterFirst);
    const runs = await testDb().agentRun.findMany({ where: { userId: userB } });
    expect(runs.map((r) => r.kind).sort()).toEqual(["profile", "suggestions"]);
  });

  it("keeps one user's activity from triggering another's refresh", async () => {
    await spend(userA, 2500);

    const result = await runDailyRefresh(deps(), new Date());

    // userB did nothing, so the scoping in the probe has to hold or their idle
    // account rides along on userA's spending.
    expect(result).toMatchObject({ scanned: 2, refreshed: 1, skipped: 1 });
    const summaries = await testDb().profileSummary.findMany();
    expect(summaries.map((s) => s.userId)).toEqual([userA]);
  });
});
