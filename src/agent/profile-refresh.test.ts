// The profiling loop's IO half: what the agent is shown, and what gets persisted.

import { describe, expect, it } from "vitest";
import type { FixedExpense, ProfileSummary, Transaction, UserProfile } from "../domain/types";
import { AppError } from "../http/errors";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfilesRepository } from "../repositories/profiles";
import type { CategoriesRepository } from "../repositories/categories";
import type {
  ProfileSummariesRepository,
  UpsertProfileSummaryInput,
} from "../repositories/profile-summaries";
import type { TransactionsRepository } from "../repositories/transactions";
import type { LlmClient, LlmRequest } from "./anthropic";
import { MODEL } from "./anthropic";
import { incrementalWindow, profilePeriod, refreshProfile } from "./profile-refresh";
import { nth } from "../test/stubs";

const USER = "user-1";
const FOOD = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-19T09:00:00.000Z");

let seq = 0;

const tx = (amountCents: number, occurredAt: string, userId = USER): Transaction => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++seq).padStart(12, "0")}`,
  userId,
  money: { amountCents, currency: "EUR" },
  categoryId: FOOD,
  occurredAt: `${occurredAt}T12:00:00.000Z`,
  createdAt: `${occurredAt}T12:00:00.000Z`,
});

const profile: UserProfile = {
  userId: USER,
  currency: "EUR",
  timezone: "UTC",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const summaryOn = (asOfDate: string): ProfileSummary => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  userId: USER,
  asOfDate,
  summary: { habits: [], trends: [], notableChanges: [] },
  narrative: "Steady.",
  model: MODEL,
  createdAt: `${asOfDate}T00:00:00.000Z`,
});

/** Paged and `userId`-scoped, so a fake cannot pass a read the real one fails. */
function fakeTransactions(seed: Transaction[]): TransactionsRepository {
  const unsupported = () => Promise.reject(new Error("not used by the profiling loop"));
  return {
    async list(userId, options = {}) {
      const size = options.limit ?? 50;
      const matching = seed
        .filter((row) => row.userId === userId)
        .filter((row) => !options.from || new Date(row.occurredAt) >= options.from)
        .filter((row) => !options.to || new Date(row.occurredAt) <= options.to)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
      const start = options.cursor ? matching.findIndex((row) => row.id === options.cursor) + 1 : 0;
      const page = matching.slice(start, start + size);
      return {
        items: page,
        nextCursor: start + size < matching.length ? (page.at(-1)?.id ?? null) : null,
      };
    },
    findById: unsupported,
    create: unsupported,
    update: unsupported,
    delete: unsupported,
  };
}

function fakeExpenses(seed: FixedExpense[] = []): FixedExpensesRepository {
  const unsupported = () => Promise.reject(new Error("not used by the profiling loop"));
  return {
    async list(userId) {
      return seed.filter((row) => row.userId === userId);
    },
    findById: unsupported,
    create: unsupported,
    update: unsupported,
    deactivate: unsupported,
  };
}

const fakeCategories: CategoriesRepository = {
  list: async () => [{ id: FOOD, key: "food", label: "Food" }],
};

function fakeProfiles(row: UserProfile | null): ProfilesRepository {
  return {
    ensure: async () => {},
    get: async (userId) => (row && row.userId === userId ? row : null),
    update: async () => null,
  };
}

function fakeSummaries(latest: ProfileSummary | null): {
  repo: ProfileSummariesRepository;
  writes: { userId: string; input: UpsertProfileSummaryInput }[];
} {
  const writes: { userId: string; input: UpsertProfileSummaryInput }[] = [];
  return {
    writes,
    repo: {
      latest: async (userId) => (latest && latest.userId === userId ? latest : null),
      upsert: async (userId, input) => {
        writes.push({ userId, input });
        return {
          id: "cccccccc-cccc-4ccc-8ccc-000000000001",
          userId,
          asOfDate: input.asOfDate.toISOString().slice(0, 10),
          summary: input.summary,
          narrative: input.narrative,
          model: input.model,
          createdAt: NOW.toISOString(),
        };
      },
    },
  };
}

/** A model that echoes no figures at all, so grounding never masks a failure. */
function recordingLlm(): { llm: LlmClient; requests: LlmRequest<unknown>[] } {
  const requests: LlmRequest<unknown>[] = [];
  const data = {
    habits: ["Eats out"],
    trends: ["Rising"],
    notableChanges: ["New gym"],
    narrative: "Spending is steady.",
  };
  return {
    requests,
    llm: {
      complete: <T>(request: LlmRequest<T>) => {
        requests.push(request as LlmRequest<unknown>);
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
    },
  };
}

function depsWith(options: {
  transactions?: Transaction[];
  previous?: ProfileSummary | null;
  profile?: UserProfile | null;
}) {
  const { llm, requests } = recordingLlm();
  const summaries = fakeSummaries(options.previous ?? null);
  return {
    requests,
    writes: summaries.writes,
    deps: {
      llm,
      transactions: fakeTransactions(options.transactions ?? []),
      expenses: fakeExpenses(),
      profiles: fakeProfiles(options.profile === undefined ? profile : options.profile),
      summaries: summaries.repo,
      categories: fakeCategories,
    },
  };
}

describe("profilePeriod", () => {
  it("reports month-to-date in UTC, matching what GET /stats defaults to", () => {
    expect(profilePeriod(NOW)).toEqual({ start: "2026-07-01", end: "2026-07-19" });
  });
});

describe("incrementalWindow", () => {
  const period = { start: "2026-07-01", end: "2026-07-19" };

  it("covers the whole period on a first refresh", () => {
    expect(incrementalWindow(null, period)).toEqual(period);
  });

  it("starts at the previous summary's own day, not the day after", () => {
    // `asOfDate` has day granularity, so the day it names was still accumulating
    // when it was written — excluding it would drop that afternoon's spending.
    expect(incrementalWindow(summaryOn("2026-07-12"), period)).toEqual({
      start: "2026-07-12",
      end: "2026-07-19",
    });
  });

  it("is empty when the previous summary postdates the period", () => {
    expect(incrementalWindow(summaryOn("2026-08-01"), period)).toBeNull();
  });

  it("floors the lookback so a long-stale profile stays refreshable", () => {
    // A year-old summary would otherwise span a year of transactions, trip the
    // ledger cap, and 422 — permanently, since nothing would ever narrow it.
    const window = incrementalWindow(summaryOn("2025-07-19"), period);

    expect(window).toEqual({ start: "2026-05-02", end: "2026-07-19" });
  });
});

describe("refreshProfile", () => {
  it("persists the summary against today, tagged with the model that wrote it", async () => {
    const { deps, writes } = depsWith({ transactions: [tx(1500, "2026-07-05")] });

    const result = await refreshProfile(deps, USER, NOW);

    expect(writes).toHaveLength(1);
    expect(nth(writes, 0).userId).toBe(USER);
    expect(nth(writes, 0).input.asOfDate.toISOString()).toBe("2026-07-19T00:00:00.000Z");
    expect(nth(writes, 0).input.model).toBe(MODEL);
    expect(result.narrative).toBe("Spending is steady.");
    expect(result.summary.habits).toEqual(["Eats out"]);
  });

  it("shows the model only activity since the previous summary", async () => {
    const { deps, requests } = depsWith({
      transactions: [tx(1000, "2026-07-03"), tx(2000, "2026-07-15")],
      previous: summaryOn("2026-07-12"),
    });

    await refreshProfile(deps, USER, NOW);

    const payload = nth(requests, 0).input;
    expect(payload).toContain("2026-07-15");
    // The 3 July transaction predates the previous summary and was already
    // folded into it — reprocessing it is the cost this loop exists to avoid.
    expect(payload).not.toContain("2026-07-03");
  });

  it("shows the whole period on a first refresh", async () => {
    const { deps, requests } = depsWith({
      transactions: [tx(1000, "2026-07-03"), tx(2000, "2026-07-15")],
    });

    await refreshProfile(deps, USER, NOW);

    expect(nth(requests, 0).input).toContain("2026-07-03");
    expect(nth(requests, 0).input).toContain("2026-07-15");
  });

  it("reads a window that predates the stats period rather than losing it", async () => {
    // A profile left stale across a month boundary: June's activity is still new
    // to the summary, so it has to be fetched even though the stats are July's.
    const { deps, requests } = depsWith({
      transactions: [tx(1000, "2026-06-20"), tx(2000, "2026-07-15")],
      previous: summaryOn("2026-06-18"),
    });

    await refreshProfile(deps, USER, NOW);

    expect(nth(requests, 0).input).toContain("2026-06-20");
    expect(nth(requests, 0).input).toContain("2026-07-15");
  });

  it("sees no new activity when the caller has none since the last summary", async () => {
    const { deps, requests } = depsWith({
      transactions: [tx(1000, "2026-07-03")],
      previous: summaryOn("2026-07-12"),
    });

    await refreshProfile(deps, USER, NOW);

    expect(nth(requests, 0).input).toContain("no new transactions since the previous summary");
  });

  it("never sees another user's transactions", async () => {
    const { deps, requests } = depsWith({
      transactions: [tx(1000, "2026-07-05"), tx(999999, "2026-07-06", "user-2")],
    });

    await refreshProfile(deps, USER, NOW);

    expect(nth(requests, 0).input).not.toContain("9999.99");
  });

  it("skips the model when today's summary exists and nothing has changed", async () => {
    // The transaction predates the summary's own write, so a second refresh has
    // nothing new to interpret and must not pay for an identical answer.
    const previous = summaryOn("2026-07-19");
    const stale = { ...tx(1500, "2026-07-05"), createdAt: "2026-07-05T12:00:00.000Z" };
    const { deps, requests, writes } = depsWith({ transactions: [stale], previous });

    const result = await refreshProfile(deps, USER, NOW);

    expect(requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(result).toBe(previous);
  });

  it("picks up a transaction backdated before the previous summary's day", async () => {
    // Entered today, dated a week ago — outside an occurredAt-anchored window,
    // but it moves the period totals the narrative sits next to, and no future
    // window would ever reach back far enough to include it.
    const previous = summaryOn("2026-07-12");
    const backdated = { ...tx(4200, "2026-07-04"), createdAt: "2026-07-19T08:00:00.000Z" };
    const { deps, requests } = depsWith({ transactions: [backdated], previous });

    await refreshProfile(deps, USER, NOW);

    expect(nth(requests, 0).input).toContain("2026-07-04");
    expect(nth(requests, 0).input).toContain("42.00 EUR");
  });

  it("does not short-circuit when the only new activity is backdated", async () => {
    const previous = summaryOn("2026-07-19");
    const backdated = { ...tx(4200, "2026-07-04"), createdAt: "2026-07-19T18:00:00.000Z" };
    const { deps, requests } = depsWith({ transactions: [backdated], previous });

    await refreshProfile(deps, USER, NOW);

    // An occurredAt-only window would be empty here, and `every` over an empty
    // list is vacuously true — the refresh would have returned the stale row.
    expect(requests).toHaveLength(1);
  });

  it("still runs when a transaction was recorded after today's summary", async () => {
    const previous = summaryOn("2026-07-19");
    const fresh = { ...tx(1500, "2026-07-19"), createdAt: "2026-07-19T18:00:00.000Z" };
    const { deps, requests } = depsWith({ transactions: [fresh], previous });

    await refreshProfile(deps, USER, NOW);

    expect(requests).toHaveLength(1);
  });

  it("is a 404 when the caller has no profile row to report a currency for", async () => {
    const { deps } = depsWith({ profile: null });

    await expect(refreshProfile(deps, USER, NOW)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(refreshProfile(deps, USER, NOW)).rejects.toBeInstanceOf(AppError);
  });
});
