import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { Suggestion, UserProfile } from "../domain/types";
import type { AuthDeps } from "../auth/plugin";
import type { ProfilesRepository } from "../repositories/profiles";
import type { SuggestionsRepository } from "../repositories/suggestions";
import type { LlmClient } from "../agent/anthropic";
import {
  emptyCategories,
  unusedLlm,
  unusedSummaries,
  unusedTransactions,
  unusedFixedExpenses,
} from "../test/stubs";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

const USER = "user-1";
const OTHER_USER = "user-2";
const FOOD = "11111111-1111-4111-8111-111111111111";

const MINE = "dddddddd-dddd-4ddd-8ddd-000000000001";
const THEIRS = "dddddddd-dddd-4ddd-8ddd-000000000002";
const ABSENT = "dddddddd-dddd-4ddd-8ddd-00000000000f";

const authAs = (id: string): AuthDeps => ({
  verifier: { verify: async () => ({ id }) },
  profiles: { ensureProfile: async () => {} },
});

const rejectingAuth: AuthDeps = {
  verifier: { verify: () => Promise.reject(new (class extends Error {})("nope")) },
  profiles: { ensureProfile: async () => {} },
};

const profileRow = (userId: string): UserProfile => ({
  userId,
  currency: "EUR",
  timezone: "UTC",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const suggestionFor = (id: string, userId: string, text: string): Suggestion => ({
  id,
  userId,
  asOfDate: "2026-07-19",
  text,
  categoryId: FOOD,
  estMonthlySavings: { amountCents: 12175, currency: "EUR" },
  rationale: "Food is your largest discretionary category.",
  sourceRefs: [`category:${FOOD}`, "stat:discretionaryTotal"],
  status: "new",
  createdAt: "2026-07-19T00:00:00.000Z",
});

function fakeProfiles(rows: UserProfile[]): ProfilesRepository {
  return {
    ensure: async () => {},
    get: async (userId) => rows.find((row) => row.userId === userId) ?? null,
    update: async () => null,
  };
}

/**
 * An in-memory suggestions repo that enforces the same ownership rule as the
 * real one: every read and write filters on `userId`, so a foreign id resolves
 * to nothing rather than to someone else's row.
 */
function fakeSuggestions(seed: Suggestion[]): SuggestionsRepository {
  const rows = [...seed];
  const owned = (userId: string, id: string) =>
    rows.find((row) => row.id === id && row.userId === userId) ?? null;

  return {
    async list(userId, options = {}) {
      const items = rows.filter(
        (row) => row.userId === userId && (!options.status || row.status === options.status),
      );
      return { items, nextCursor: null };
    },
    async findById(userId, id) {
      return owned(userId, id);
    },
    create: () => Promise.reject(new Error("not used by these tests")),
    async setStatus(userId, id, status) {
      const row = owned(userId, id);
      if (!row) return null;
      row.status = status;
      return row;
    },
  };
}

function appWith(options: {
  auth?: AuthDeps;
  suggestions?: Suggestion[];
  profiles?: UserProfile[];
  llm?: LlmClient;
}) {
  return buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth: options.auth ?? authAs(USER),
    llm: options.llm ?? unusedLlm,
    repos: {
      categories: emptyCategories,
      expenses: unusedFixedExpenses,
      transactions: unusedTransactions,
      profiles: fakeProfiles(options.profiles ?? [profileRow(USER)]),
      summaries: unusedSummaries,
      suggestions: fakeSuggestions(options.suggestions ?? []),
    },
  });
}

const authed = { authorization: "Bearer token" };

const seeded = () => [
  suggestionFor(MINE, USER, "Cook at home two more evenings a week."),
  suggestionFor(THEIRS, OTHER_USER, "Cancel the gym."),
];

describe("GET /suggestions", () => {
  it("returns only the caller's suggestions", async () => {
    const app = appWith({ suggestions: seeded() });

    const res = await app.inject({ method: "GET", url: "/suggestions", headers: authed });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].id).toBe(MINE);
    expect(body.nextCursor).toBeNull();
  });

  it("carries the computed figure and its citations through the response", async () => {
    const app = appWith({ suggestions: seeded() });

    const res = await app.inject({ method: "GET", url: "/suggestions", headers: authed });
    await app.close();

    expect(res.json().suggestions[0]).toMatchObject({
      estMonthlySavings: { amountCents: 12175, currency: "EUR" },
      sourceRefs: [`category:${FOOD}`, "stat:discretionaryTotal"],
    });
  });

  it("filters by status", async () => {
    const app = appWith({ suggestions: seeded() });

    const res = await app.inject({
      method: "GET",
      url: "/suggestions?status=dismissed",
      headers: authed,
    });
    await app.close();

    expect(res.json().suggestions).toHaveLength(0);
  });

  it("rejects an unknown query parameter", async () => {
    const app = appWith({ suggestions: seeded() });

    const res = await app.inject({
      method: "GET",
      url: "/suggestions?userId=user-2",
      headers: authed,
    });
    await app.close();

    // `.strict()`: a body or query smuggling a userId is a 400, never a field
    // that gets quietly dropped and read as "everyone's".
    expect(res.statusCode).toBe(400);
  });

  it("rejects a limit past the page cap", async () => {
    const app = appWith({ suggestions: seeded() });

    const res = await app.inject({
      method: "GET",
      url: "/suggestions?limit=5000",
      headers: authed,
    });
    await app.close();

    expect(res.statusCode).toBe(400);
  });

  it("requires a token", async () => {
    const app = appWith({ auth: rejectingAuth, suggestions: seeded() });

    const res = await app.inject({ method: "GET", url: "/suggestions" });
    await app.close();

    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /suggestions/:id", () => {
  const patch = (
    id: string,
    body: Record<string, unknown>,
    auth?: AuthDeps,
    rows?: Suggestion[],
  ) => {
    const app = appWith({ auth, suggestions: rows ?? seeded() });
    return app
      .inject({ method: "PATCH", url: `/suggestions/${id}`, headers: authed, payload: body })
      .then(async (res) => {
        await app.close();
        return res;
      });
  };

  it("dismisses the caller's own suggestion", async () => {
    const res = await patch(MINE, { status: "dismissed" });

    expect(res.statusCode).toBe(200);
    expect(res.json().suggestion).toMatchObject({ id: MINE, status: "dismissed" });
  });

  it("marks one applied", async () => {
    const res = await patch(MINE, { status: "applied" });

    expect(res.statusCode).toBe(200);
    expect(res.json().suggestion.status).toBe("applied");
  });

  it("returns 404 for another user's suggestion, never their row", async () => {
    const res = await patch(THEIRS, { status: "dismissed" });

    expect(res.statusCode).toBe(404);
    // The body must not confirm the row exists on another account.
    expect(res.body).not.toContain("Cancel the gym");
  });

  it("returns the same 404 for an id that does not exist at all", async () => {
    const res = await patch(ABSENT, { status: "dismissed" });

    expect(res.statusCode).toBe(404);
  });

  it("refuses to rewind a suggestion to `new`", async () => {
    const res = await patch(MINE, { status: "new" });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown status", async () => {
    const res = await patch(MINE, { status: "snoozed" });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed id", async () => {
    const res = await patch("not-a-uuid", { status: "dismissed" });

    expect(res.statusCode).toBe(400);
  });

  it("requires a token", async () => {
    const app = appWith({ auth: rejectingAuth, suggestions: seeded() });

    const res = await app.inject({
      method: "PATCH",
      url: `/suggestions/${MINE}`,
      payload: { status: "dismissed" },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });
});

describe("POST /suggestions/refresh", () => {
  it("returns the day's existing set without paying for a second model call", async () => {
    // `unusedLlm` rejects if called — the assertion is that it is not.
    const app = appWith({ suggestions: seeded(), llm: unusedLlm });

    const res = await app.inject({
      method: "POST",
      url: "/suggestions/refresh",
      headers: authed,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().suggestions).toHaveLength(1);
  });

  it("requires a token", async () => {
    const app = appWith({ auth: rejectingAuth, suggestions: seeded() });

    const res = await app.inject({ method: "POST", url: "/suggestions/refresh" });
    await app.close();

    expect(res.statusCode).toBe(401);
  });
});
