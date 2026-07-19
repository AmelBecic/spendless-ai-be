import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { ProfileSummary, Transaction, UserProfile } from "../domain/types";
import type { AuthDeps } from "../auth/plugin";
import type { ProfilesRepository } from "../repositories/profiles";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
import type { TransactionsRepository } from "../repositories/transactions";
import type { LlmClient } from "../agent/anthropic";
import { MODEL } from "../agent/anthropic";
import { emptyCategories, unusedLlm, unusedSummaries } from "../test/stubs";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

const USER = "user-1";
const OTHER_USER = "user-2";
const FOOD = "11111111-1111-4111-8111-111111111111";

const authAs = (id: string): AuthDeps => ({
  verifier: { verify: async () => ({ id }) },
  profiles: { ensureProfile: async () => {} },
});

const rejectingAuth: AuthDeps = {
  verifier: {
    verify: () => Promise.reject(new (class extends Error {})("nope")),
  },
  profiles: { ensureProfile: async () => {} },
};

const profileRow = (userId: string): UserProfile => ({
  userId,
  currency: "EUR",
  timezone: "UTC",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const summaryFor = (userId: string, narrative: string): ProfileSummary => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${userId.padEnd(12, "0")}`,
  userId,
  asOfDate: "2026-07-18",
  summary: { habits: [`${userId} habit`], trends: [], notableChanges: [] },
  narrative,
  model: MODEL,
  createdAt: "2026-07-18T00:00:00.000Z",
});

const tx = (userId: string, amountCents: number): Transaction => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-${userId.padEnd(12, "0")}`,
  userId,
  money: { amountCents, currency: "EUR" },
  categoryId: FOOD,
  occurredAt: `${new Date().toISOString().slice(0, 10)}T09:00:00.000Z`,
  createdAt: "2026-07-01T00:00:00.000Z",
});

function fakeProfiles(rows: UserProfile[]): ProfilesRepository {
  return {
    ensure: async () => {},
    get: async (userId) => rows.find((row) => row.userId === userId) ?? null,
    update: async () => null,
  };
}

function fakeTransactions(seed: Transaction[]): TransactionsRepository {
  const unsupported = () => Promise.reject(new Error("not used by /profile"));
  return {
    async list(userId) {
      return { items: seed.filter((row) => row.userId === userId), nextCursor: null };
    },
    findById: unsupported,
    create: unsupported,
    update: unsupported,
    delete: unsupported,
  };
}

function fakeSummaries(seed: ProfileSummary[]): ProfileSummariesRepository {
  const rows = [...seed];
  return {
    latest: async (userId) => rows.find((row) => row.userId === userId) ?? null,
    upsert: async (userId, input) => {
      const row: ProfileSummary = {
        id: "cccccccc-cccc-4ccc-8ccc-000000000001",
        userId,
        asOfDate: input.asOfDate.toISOString().slice(0, 10),
        summary: input.summary,
        narrative: input.narrative,
        model: input.model,
        createdAt: "2026-07-19T00:00:00.000Z",
      };
      rows.push(row);
      return row;
    },
  };
}

const groundedLlm: LlmClient = {
  complete: <T>() =>
    Promise.resolve({
      data: {
        habits: ["Eats out on weekdays"],
        trends: ["Food spend rising"],
        notableChanges: ["Joined a gym"],
        narrative: "Your spending held steady this month.",
      } as unknown as T,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedCostUsd: 0,
      },
    }),
};

function appWith(options: {
  auth?: AuthDeps;
  summaries?: ProfileSummary[];
  profiles?: UserProfile[];
  transactions?: Transaction[];
  llm?: LlmClient;
}) {
  return buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth: options.auth ?? authAs(USER),
    llm: options.llm ?? groundedLlm,
    repos: {
      categories: emptyCategories,
      expenses: {
        list: async () => [],
        findById: () => Promise.reject(new Error("unused")),
        create: () => Promise.reject(new Error("unused")),
        update: () => Promise.reject(new Error("unused")),
        deactivate: () => Promise.reject(new Error("unused")),
      },
      transactions: fakeTransactions(options.transactions ?? []),
      profiles: fakeProfiles(options.profiles ?? [profileRow(USER)]),
      summaries: options.summaries ? fakeSummaries(options.summaries) : unusedSummaries,
    },
  });
}

const authed = { authorization: "Bearer token" };

describe("GET /profile", () => {
  it("returns the caller's latest summary", async () => {
    const app = appWith({ summaries: [summaryFor(USER, "Mine.")] });

    const res = await app.inject({ method: "GET", url: "/profile", headers: authed });

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.narrative).toBe("Mine.");
    expect(res.json().profile.model).toBe(MODEL);
  });

  it("is a 404 before the first refresh", async () => {
    const app = appWith({ summaries: [] });

    const res = await app.inject({ method: "GET", url: "/profile", headers: authed });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("is a 401 without a valid token", async () => {
    const app = appWith({ auth: rejectingAuth, summaries: [summaryFor(USER, "Mine.")] });

    const res = await app.inject({ method: "GET", url: "/profile" });

    expect(res.statusCode).toBe(401);
  });

  it("never returns another user's summary", async () => {
    // Both rows exist; the caller is user-2, who has none of their own.
    const app = appWith({
      auth: authAs(OTHER_USER),
      summaries: [summaryFor(USER, "Mine.")],
      profiles: [profileRow(USER), profileRow(OTHER_USER)],
    });

    const res = await app.inject({ method: "GET", url: "/profile", headers: authed });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /profile/refresh", () => {
  it("runs the agent and returns the persisted summary", async () => {
    const app = appWith({ summaries: [], transactions: [tx(USER, 2500)] });

    const res = await app.inject({ method: "POST", url: "/profile/refresh", headers: authed });

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.narrative).toBe("Your spending held steady this month.");
    expect(res.json().profile.model).toBe(MODEL);
    expect(res.json().profile.summary.habits).toEqual(["Eats out on weekdays"]);
  });

  it("makes the new summary readable through GET /profile", async () => {
    const app = appWith({ summaries: [], transactions: [tx(USER, 2500)] });

    await app.inject({ method: "POST", url: "/profile/refresh", headers: authed });
    const res = await app.inject({ method: "GET", url: "/profile", headers: authed });

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.narrative).toBe("Your spending held steady this month.");
  });

  it("is a 401 without a valid token, and never reaches the model", async () => {
    const app = appWith({ auth: rejectingAuth, llm: unusedLlm, summaries: [] });

    const res = await app.inject({ method: "POST", url: "/profile/refresh" });

    expect(res.statusCode).toBe(401);
  });

  it("is a 502 when the model reports a figure the stats do not contain", async () => {
    const fabricating: LlmClient = {
      complete: <T>() =>
        Promise.resolve({
          data: {
            habits: [],
            trends: [],
            notableChanges: [],
            narrative: "You spent 8888.88 EUR this month.",
          } as unknown as T,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            estimatedCostUsd: 0,
          },
        }),
    };
    const app = appWith({ summaries: [], transactions: [tx(USER, 2500)], llm: fabricating });

    const res = await app.inject({ method: "POST", url: "/profile/refresh", headers: authed });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("LLM_UNGROUNDED");
  });

  it("refreshes the caller's own profile even when another user's exists", async () => {
    const app = appWith({
      auth: authAs(OTHER_USER),
      summaries: [summaryFor(USER, "Mine.")],
      profiles: [profileRow(USER), profileRow(OTHER_USER)],
      transactions: [tx(USER, 999999), tx(OTHER_USER, 2500)],
    });

    const res = await app.inject({ method: "POST", url: "/profile/refresh", headers: authed });

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.userId).toBe(OTHER_USER);
  });
});
