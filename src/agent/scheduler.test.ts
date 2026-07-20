// The daily refresh job. The property under test throughout is cost: which
// users buy a completion, which do not, and what happens to the pass when one
// user goes wrong.

import { describe, it, expect } from "vitest";
import type { FixedExpense, ProfileSummary, Transaction, UserProfile } from "../domain/types";
import type { LlmClient, LlmRequest } from "../agent/anthropic";
import type { CategoriesRepository } from "../repositories/categories";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfilesRepository } from "../repositories/profiles";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
import type { SuggestionsRepository } from "../repositories/suggestions";
import type { TransactionsRepository } from "../repositories/transactions";
import type { AgentRunsRepository, AgentRunKind } from "../repositories/agent-runs";
import { runDailyRefresh, type DailyRefreshDeps } from "./scheduler";

const FOOD = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-07-20T12:00:00.000Z");

/** A summary written at `createdAt` — the anchor every novelty check measures from. */
function summary(userId: string, createdAt: string): ProfileSummary {
  return {
    id: `sum-${userId}`,
    userId,
    asOfDate: createdAt.slice(0, 10),
    summary: { habits: [], trends: [], notableChanges: [] },
    narrative: "Steady month.",
    model: "claude-opus-4-8",
    createdAt,
  };
}

function transaction(userId: string, createdAt: string): Transaction {
  return {
    id: `tx-${userId}-${createdAt}`,
    userId,
    money: { amountCents: 2500, currency: "EUR" },
    categoryId: FOOD,
    occurredAt: `${createdAt.slice(0, 10)}T09:00:00.000Z`,
    createdAt,
  };
}

interface WorldOptions {
  users: string[];
  /** Per user: the last summary, if any. */
  summaries?: Record<string, ProfileSummary>;
  /** Per user: transactions, keyed by the `createdAt` the counts filter on. */
  transactions?: Record<string, Transaction[]>;
  /** Per user: how many commitments changed since the anchor. */
  expenseChanges?: Record<string, number>;
  /** Per user: make the model call fail. */
  failFor?: Set<string>;
  /** Per user: fail only the *suggestion* call, leaving the profile half to land. */
  failSuggestionsFor?: Set<string>;
  /** Per user: make the model call hang forever. */
  hangFor?: Set<string>;
  /** Per user: let the model succeed but fail the write that persists its output. */
  failPersistFor?: Set<string>;
  pageSize?: number;
}

interface World {
  deps: DailyRefreshDeps;
  /** Every model call made, in order. */
  calls: LlmRequest<unknown>[];
  releases: { userId: string; kind: AgentRunKind }[];
  errors: Record<string, unknown>[];
  /** Mutable, so a test can let a previously-failing half succeed on a later pass. */
  failSuggestions: Set<string>;
  /** The recorded passes, as `userId:kind` — the receipts, observable. */
  runs: Set<string>;
}

/**
 * A whole world for one pass: a roster, per-user ledgers, and an LLM that
 * records every call it receives. Assembled here rather than per test so each
 * test states only the thing it is about.
 */
function world(options: WorldOptions): World {
  const calls: LlmRequest<unknown>[] = [];
  const releases: { userId: string; kind: AgentRunKind }[] = [];
  const errors: Record<string, unknown>[] = [];
  const held = new Set<string>();
  const failSuggestions = new Set(options.failSuggestionsFor ?? []);

  const pageSize = options.pageSize ?? 50;
  const profiles: ProfilesRepository = {
    ensure: async () => {},
    get: async (userId): Promise<UserProfile | null> => ({
      userId,
      currency: "EUR",
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    update: async () => null,
    async listUserIds(opts = {}) {
      const start = opts.cursor ? options.users.indexOf(opts.cursor) + 1 : 0;
      const page = options.users.slice(start, start + pageSize);
      return {
        items: page,
        nextCursor: start + pageSize < options.users.length ? (page.at(-1) ?? null) : null,
      };
    },
  };

  const rejects = (what: string) => () => Promise.reject(new Error(`${what} unused in this test`));

  const transactions: TransactionsRepository = {
    async list(userId) {
      return { items: options.transactions?.[userId] ?? [], nextCursor: null };
    },
    findById: rejects("findById"),
    create: rejects("create"),
    update: rejects("update"),
    delete: rejects("delete"),
    async countCreatedSince(userId, since) {
      return (options.transactions?.[userId] ?? []).filter((tx) => new Date(tx.createdAt) > since)
        .length;
    },
  };

  const expenses: FixedExpensesRepository = {
    async list(): Promise<FixedExpense[]> {
      return [];
    },
    findById: rejects("findById"),
    create: rejects("create"),
    update: rejects("update"),
    deactivate: rejects("deactivate"),
    async countChangedSince(userId) {
      return options.expenseChanges?.[userId] ?? 0;
    },
  };

  const summaries: ProfileSummariesRepository = {
    async latest(userId) {
      return options.summaries?.[userId] ?? null;
    },
    async upsert(userId, input) {
      return {
        id: `sum-${userId}`,
        userId,
        asOfDate: input.asOfDate.toISOString().slice(0, 10),
        summary: input.summary,
        narrative: input.narrative,
        model: input.model,
        createdAt: NOW.toISOString(),
      };
    },
  };

  const suggestions: SuggestionsRepository = {
    async list() {
      return { items: [], nextCursor: null };
    },
    findById: rejects("findById"),
    create: rejects("create"),
    async createDailySet(userId) {
      if (options.failPersistFor?.has(userId)) {
        throw new Error(`persisting the set failed for ${userId}`);
      }
      return [];
    },
    setStatus: rejects("setStatus"),
  };

  const agentRuns: AgentRunsRepository = {
    async claim(userId, kind) {
      const key = `${userId}:${kind}`;
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    async release(userId, kind) {
      releases.push({ userId, kind });
      held.delete(`${userId}:${kind}`);
    },
    async hasRun(userId, kind) {
      return held.has(`${userId}:${kind}`);
    },
  };

  const categories: CategoriesRepository = {
    list: async () => [{ id: FOOD, key: "food", label: "Food" }],
  };

  const llm: LlmClient = {
    complete: <T>(request: LlmRequest<T>): Promise<{ data: T; usage: never }> => {
      calls.push(request as LlmRequest<unknown>);
      const userId = currentUser;
      if (userId && options.hangFor?.has(userId)) return new Promise<never>(() => {});
      if (userId && options.failFor?.has(userId)) {
        return Promise.reject(new Error(`model exploded for ${userId}`));
      }
      if (userId && request.schemaName === "savings_suggestions" && failSuggestions.has(userId)) {
        return Promise.reject(new Error(`suggestion half exploded for ${userId}`));
      }
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
        } as never,
      });
    },
  };

  // The LLM stub needs to know whose turn it is to fail; the scheduler walks
  // users sequentially, so tracking the current one through `latest` is exact.
  let currentUser: string | undefined;
  const trackingSummaries: ProfileSummariesRepository = {
    ...summaries,
    async latest(userId) {
      currentUser = userId;
      return summaries.latest(userId);
    },
  };

  const deps: DailyRefreshDeps = {
    llm,
    transactions,
    expenses,
    profiles,
    summaries: trackingSummaries,
    suggestions,
    agentRuns,
    categories,
    logger: {
      info: () => {},
      warn: () => {},
      error: (details) => {
        errors.push(details);
      },
    },
  };

  return { deps, calls, releases, errors, failSuggestions, runs: held };
}

describe("runDailyRefresh", () => {
  it("makes no model call for a user with no activity since their last summary", async () => {
    // The headline cost guarantee: an idle user is free. `calls` staying empty is
    // the assertion — a completion for this user is money spent to regenerate the
    // summary that is already stored.
    const { deps, calls } = world({
      users: ["idle-user"],
      summaries: { "idle-user": summary("idle-user", "2026-07-19T10:00:00.000Z") },
      // Entered *before* the summary was written, so nothing is new.
      transactions: { "idle-user": [transaction("idle-user", "2026-07-19T08:00:00.000Z")] },
    });

    const result = await runDailyRefresh(deps, NOW);

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ scanned: 1, refreshed: 0, skipped: 1, failed: 0 });
  });

  it("refreshes a user who has recorded something since their last summary", async () => {
    const { deps, calls } = world({
      users: ["active-user"],
      summaries: { "active-user": summary("active-user", "2026-07-19T10:00:00.000Z") },
      transactions: { "active-user": [transaction("active-user", "2026-07-20T09:00:00.000Z")] },
    });

    const result = await runDailyRefresh(deps, NOW);

    // Both agents ran, in order: the suggestion pass reads the summary the
    // profile pass just wrote.
    expect(calls.map((c) => c.schemaName)).toEqual(["profile_summary", "savings_suggestions"]);
    expect(result).toMatchObject({ scanned: 1, refreshed: 1, skipped: 0, failed: 0 });
  });

  it("treats a changed commitment as activity even with no new spending", async () => {
    // A cancelled subscription moves the commitment total the narrative quotes,
    // so the month is not idle even though nothing was spent.
    const { deps, calls } = world({
      users: ["restructured"],
      summaries: { restructured: summary("restructured", "2026-07-19T10:00:00.000Z") },
      transactions: { restructured: [] },
      expenseChanges: { restructured: 1 },
    });

    await runDailyRefresh(deps, NOW);

    expect(calls.length).toBeGreaterThan(0);
  });

  it("makes no model call for a signed-up user who has entered nothing at all", async () => {
    // No previous summary means novelty is measured from the epoch, so an empty
    // account is idle rather than "never summarised, therefore refresh me".
    const { deps, calls } = world({ users: ["newcomer"], transactions: { newcomer: [] } });

    const result = await runDailyRefresh(deps, NOW);

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ skipped: 1, refreshed: 0 });
  });

  it("refreshes a user who has data but has never been summarised", async () => {
    const { deps, calls } = world({
      users: ["unsummarised"],
      transactions: { unsummarised: [transaction("unsummarised", "2026-07-20T09:00:00.000Z")] },
    });

    await runDailyRefresh(deps, NOW);

    expect(calls.map((c) => c.schemaName)).toEqual(["profile_summary", "savings_suggestions"]);
  });

  it("keeps going when one user fails, and reports the failure", async () => {
    // A pass that aborted on the first bad user would leave everyone behind them
    // stale — and on a paid path would discard the completions already bought.
    const { deps, calls, errors } = world({
      users: ["first", "broken", "last"],
      transactions: {
        first: [transaction("first", "2026-07-20T09:00:00.000Z")],
        broken: [transaction("broken", "2026-07-20T09:00:00.000Z")],
        last: [transaction("last", "2026-07-20T09:00:00.000Z")],
      },
      failFor: new Set(["broken"]),
    });

    const result = await runDailyRefresh(deps, NOW);

    // `refreshed: 2` is the load-bearing number — the user *after* the failure
    // was still served, which is what an aborting loop would have skipped.
    expect(result).toMatchObject({ scanned: 3, refreshed: 2, failed: 1 });
    expect(calls.filter((c) => c.schemaName === "profile_summary")).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ userId: "broken" });
  });

  it("releases the day's claim when a user's refresh fails", async () => {
    // The claim is taken before the work. Left standing after a transient
    // failure it would skip that user until midnight.
    const { deps, releases } = world({
      users: ["broken"],
      transactions: { broken: [transaction("broken", "2026-07-20T09:00:00.000Z")] },
      failFor: new Set(["broken"]),
    });

    await runDailyRefresh(deps, NOW);

    expect(releases).toContainEqual({ userId: "broken", kind: "profile" });
  });

  it("does not pay twice when a pass has already run for the day", async () => {
    const { deps, calls } = world({
      users: ["active"],
      transactions: { active: [transaction("active", "2026-07-20T09:00:00.000Z")] },
    });

    await runDailyRefresh(deps, NOW);
    const afterFirst = calls.length;
    // A cron that fires twice, or an overlapping run, must not re-buy the day.
    await runDailyRefresh(deps, NOW);

    expect(calls.length).toBe(afterFirst);
  });

  it("resumes the suggestion half after it fails, instead of stranding the user", async () => {
    // The trap: the profile half writes a summary, and `isIdle` measures novelty
    // from that summary. So a pass whose profile succeeded and whose suggestions
    // failed leaves the user looking freshly-summarised-and-idle on every later
    // pass — and their suggestions are never generated again, silently, until
    // they happen to spend something.
    const w = world({
      users: ["half-done"],
      transactions: { "half-done": [transaction("half-done", "2026-07-20T09:00:00.000Z")] },
      failSuggestionsFor: new Set(["half-done"]),
    });

    const first = await runDailyRefresh(w.deps, NOW);
    expect(first).toMatchObject({ refreshed: 0, failed: 1 });
    // The profile summary landed, so the user is now "idle" by construction.
    expect(w.calls.map((c) => c.schemaName)).toEqual(["profile_summary", "savings_suggestions"]);

    // Second pass, same day, nothing new recorded. The user must still be picked
    // up — and only the unfinished half re-run.
    w.failSuggestions.clear();
    const second = await runDailyRefresh(w.deps, NOW);

    expect(second).toMatchObject({ scanned: 1, refreshed: 1, skipped: 0, failed: 0 });
    expect(w.calls.map((c) => c.schemaName)).toEqual([
      "profile_summary",
      "savings_suggestions",
      // The profile half is not re-bought — it already succeeded today.
      "savings_suggestions",
    ]);
  });

  it("does not record the day when persisting the suggestion set fails", async () => {
    // The receipt goes after the durable write, not after the model call.
    // Recorded in between, a failed insert marks the day done with nothing
    // stored — precisely the outcome recording-on-success exists to prevent.
    const w = world({
      users: ["unlucky"],
      transactions: { unlucky: [transaction("unlucky", "2026-07-20T09:00:00.000Z")] },
      expenseChanges: { unlucky: 1 },
      failPersistFor: new Set(["unlucky"]),
    });

    await runDailyRefresh(w.deps, NOW);

    expect(w.runs.has("unlucky:suggestions")).toBe(false);
  });

  it("holds the claim when a profile refresh times out", async () => {
    // `withTimeout` abandons the operation, it cannot cancel it — so the refresh
    // may still be in flight and may still write. Releasing the claim would let a
    // later tick buy a second completion for a user already being served.
    const { deps, releases } = world({
      users: ["hung"],
      transactions: { hung: [transaction("hung", "2026-07-20T09:00:00.000Z")] },
      hangFor: new Set(["hung"]),
    });

    await runDailyRefresh(deps, NOW, { perUserTimeoutMs: 20 });

    expect(releases).toEqual([]);
  });

  it("bounds a hung model call instead of stalling the whole pass", async () => {
    const { deps, errors } = world({
      users: ["hung", "next"],
      transactions: {
        hung: [transaction("hung", "2026-07-20T09:00:00.000Z")],
        next: [transaction("next", "2026-07-20T09:00:00.000Z")],
      },
      hangFor: new Set(["hung"]),
    });

    const result = await runDailyRefresh(deps, NOW, { perUserTimeoutMs: 20 });

    // The hung user is charged to `failed`, and the one behind them is served.
    expect(result).toMatchObject({ scanned: 2, refreshed: 1, failed: 1 });
    expect(errors[0]).toMatchObject({ userId: "hung" });
  });

  it("walks every page of the roster", async () => {
    const users = Array.from({ length: 7 }, (_, i) => `user-${i}`);
    const transactions = Object.fromEntries(
      users.map((u) => [u, [transaction(u, "2026-07-20T09:00:00.000Z")]]),
    );
    const { deps } = world({ users, transactions, pageSize: 3 });

    const result = await runDailyRefresh(deps, NOW, { pageSize: 3 });

    // 7 users over pages of 3 — a single-page walk would report 3.
    expect(result.scanned).toBe(7);
    expect(result.refreshed).toBe(7);
  });

  it("sends a byte-identical cached prefix for every user, so the cache is reused", async () => {
    // The caching AC. The prefix is what carries the cache breakpoint, so if any
    // per-user data leaked into it, every call would rewrite the cache instead of
    // reading it — silently, at ~1.25x input price forever.
    const users = ["alice", "bob", "carol"];
    const transactions = Object.fromEntries(
      users.map((u) => [u, [transaction(u, "2026-07-20T09:00:00.000Z")]]),
    );
    const { deps, calls } = world({ users, transactions });

    await runDailyRefresh(deps, NOW);

    const prefixes = (name: string) =>
      new Set(calls.filter((c) => c.schemaName === name).map((c) => c.system));

    expect(prefixes("profile_summary").size).toBe(1);
    expect(prefixes("savings_suggestions").size).toBe(1);
    // And the payloads did vary — otherwise the assertion above would hold
    // trivially for a stub that sent the same request three times.
    expect(new Set(calls.map((c) => c.input)).size).toBeGreaterThan(1);
  });
});
