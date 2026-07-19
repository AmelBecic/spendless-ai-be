import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { FixedExpense, Transaction, UserProfile } from "../domain/types";
import type { AuthDeps } from "../auth/plugin";
import type { FixedExpensesRepository } from "../repositories/fixed-expenses";
import type { ProfilesRepository } from "../repositories/profiles";
import type { TransactionsRepository } from "../repositories/transactions";
import { emptyCategories } from "../test/stubs";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

const USER = "user-1";
const OTHER_USER = "user-2";
const FOOD = "11111111-1111-4111-8111-111111111111";
const HEALTH = "33333333-3333-4333-8333-333333333333";

const authAs = (id: string): AuthDeps => ({
  verifier: { verify: async () => ({ id }) },
  profiles: { ensureProfile: async () => {} },
});

let seq = 0;

const tx = (
  amountCents: number,
  occurredAt: string,
  opts: { userId?: string; currency?: string; categoryId?: string } = {},
): Transaction => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++seq).padStart(12, "0")}`,
  userId: opts.userId ?? USER,
  money: { amountCents, currency: opts.currency ?? "EUR" },
  categoryId: opts.categoryId ?? FOOD,
  occurredAt: occurredAt.includes("T") ? occurredAt : `${occurredAt}T12:00:00.000Z`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const gym: FixedExpense = {
  id: "cccccccc-cccc-4ccc-8ccc-000000000001",
  userId: USER,
  label: "Gym",
  categoryId: HEALTH,
  money: { amountCents: 5000, currency: "EUR" },
  cadence: "weekly",
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const profile = (currency: string): UserProfile => ({
  userId: USER,
  currency,
  timezone: "UTC",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * A paged, `userId`-scoped stand-in. The paging is real — the route walks the
 * cursor to total a whole period, and a fake that returned everything at once
 * would let a single-page read pass.
 */
function fakeTransactions(seed: Transaction[]): TransactionsRepository {
  const unsupported = () => Promise.reject(new Error("not used by /stats"));
  return {
    async list(userId, options = {}) {
      const size = options.limit ?? 50;
      const matching = seed
        .filter((row) => row.userId === userId)
        .filter((row) => !options.from || new Date(row.occurredAt) >= options.from)
        .filter((row) => !options.to || new Date(row.occurredAt) <= options.to)
        .sort((a, b) =>
          a.occurredAt === b.occurredAt
            ? a.id.localeCompare(b.id)
            : b.occurredAt.localeCompare(a.occurredAt),
        );

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

function fakeExpenses(seed: FixedExpense[]): FixedExpensesRepository {
  const unsupported = () => Promise.reject(new Error("not used by /stats"));
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

function fakeProfiles(row: UserProfile | null): ProfilesRepository {
  return {
    ensure: async () => {},
    get: async (userId) => (row && row.userId === userId ? row : null),
    update: async () => null,
  };
}

function appWith(options: {
  transactions?: Transaction[];
  expenses?: FixedExpense[];
  profile?: UserProfile | null;
  auth?: AuthDeps;
  transactionsRepo?: TransactionsRepository;
}) {
  return buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth: options.auth ?? authAs(USER),
    repos: {
      categories: emptyCategories,
      expenses: fakeExpenses(options.expenses ?? []),
      transactions: options.transactionsRepo ?? fakeTransactions(options.transactions ?? []),
      profiles: fakeProfiles(options.profile === undefined ? profile("EUR") : options.profile),
    },
  });
}

const get = (app: ReturnType<typeof buildApp>, url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: "Bearer token" } });

// The same seven-day window the aggregation's unit tests work through by hand.
const WINDOW = "from=2026-07-06&to=2026-07-12";

describe("GET /stats", () => {
  it("returns the period's stats for the caller", async () => {
    const app = appWith({
      transactions: [
        tx(2500, "2026-07-07"),
        tx(1500, "2026-07-09"),
        // Previous comparable window (2026-06-29..2026-07-05).
        tx(3000, "2026-07-02"),
      ],
      expenses: [gym],
    });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.statusCode).toBe(200);

    const { stats } = res.json();
    expect(stats.periodStart).toBe("2026-07-06");
    expect(stats.periodEnd).toBe("2026-07-12");
    expect(stats.currency).toBe("EUR");
    expect(stats.discretionaryTotal).toEqual({ amountCents: 4000, currency: "EUR" });
    expect(stats.recurringTotal).toEqual({ amountCents: 5000, currency: "EUR" });
    expect(stats.total).toEqual({ amountCents: 9000, currency: "EUR" });
    // Current 9000 vs previous 3000 + the same 5000 gym = 8000.
    expect(stats.momDeltaCents).toBe(1000);
    await app.close();
  });

  it("reports zeroes in the profile's currency for a user with no ledger", async () => {
    const app = appWith({ profile: profile("USD") });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toMatchObject({
      currency: "USD",
      total: { amountCents: 0, currency: "USD" },
      byCategory: [],
      momDeltaCents: 0,
    });
    await app.close();
  });

  it("excludes transactions outside the period", async () => {
    const app = appWith({
      transactions: [tx(2500, "2026-07-07"), tx(9999, "2026-09-01")],
    });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.json().stats.total).toEqual({ amountCents: 2500, currency: "EUR" });
    await app.close();
  });

  it("covers the whole of the day named by `to`", async () => {
    // 23:30 on the last day: an `lte` against bare midnight would drop it.
    const app = appWith({ transactions: [tx(2500, "2026-07-12T23:30:00.000Z")] });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.json().stats.total).toEqual({ amountCents: 2500, currency: "EUR" });
    await app.close();
  });

  it("totals a period spanning more than one page of transactions", async () => {
    // 450 rows against a 200-row page: a handler reading one page would report
    // 20000 instead of 45000.
    const many = Array.from({ length: 450 }, () => tx(100, "2026-07-08"));
    const app = appWith({ transactions: many });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.json().stats.total).toEqual({ amountCents: 45000, currency: "EUR" });
    await app.close();
  });

  it("never counts another user's spend", async () => {
    const app = appWith({
      transactions: [tx(2500, "2026-07-07"), tx(999999, "2026-07-08", { userId: OTHER_USER })],
      expenses: [gym, { ...gym, id: "cccccccc-cccc-4ccc-8ccc-000000000002", userId: OTHER_USER }],
    });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.json().stats.total).toEqual({ amountCents: 7500, currency: "EUR" });
    await app.close();
  });

  it("defaults to month-to-date in UTC", async () => {
    const app = appWith({});
    const today = new Date().toISOString().slice(0, 10);

    const res = await get(app, "/stats");
    expect(res.statusCode).toBe(200);
    expect(res.json().stats.periodStart).toBe(`${today.slice(0, 7)}-01`);
    expect(res.json().stats.periodEnd).toBe(today);
    await app.close();
  });

  it("anchors the start to `to`'s month when only `to` is given", async () => {
    const app = appWith({});

    const res = await get(app, "/stats?to=2026-03-15");
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toMatchObject({ periodStart: "2026-03-01", periodEnd: "2026-03-15" });
    await app.close();
  });

  it("does not invert the window when `from` is in the future", async () => {
    const app = appWith({});

    const res = await get(app, "/stats?from=2099-01-05");
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toMatchObject({ periodStart: "2099-01-05", periodEnd: "2099-01-05" });
    await app.close();
  });

  it("reads a zoned date-time as the UTC day it falls in", async () => {
    const app = appWith({});

    // 00:30 at +02:00 is still 2026-06-30 in UTC.
    const res = await get(app, "/stats?from=2026-07-01T00:30:00%2B02:00&to=2026-07-05");
    expect(res.json().stats.periodStart).toBe("2026-06-30");
    await app.close();
  });

  it("rejects a ledger that mixes currencies rather than adding them", async () => {
    const app = appWith({
      transactions: [tx(2500, "2026-07-07"), tx(1000, "2026-07-08", { currency: "USD" })],
    });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("MIXED_CURRENCY");
    await app.close();
  });

  it("accepts a period of exactly the maximum span", async () => {
    const app = appWith({});
    // 2026-01-01..2027-01-01 inclusive is 366 days.
    const res = await get(app, "/stats?from=2026-01-01&to=2027-01-01");
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects an oversized period before issuing a single query", async () => {
    // The repository throws if touched, so a 400 here proves the span was
    // rejected up front rather than after two full cursor walks.
    const untouchable: TransactionsRepository = {
      ...fakeTransactions([]),
      list: () => Promise.reject(new Error("repository must not be queried")),
    };
    const app = appWith({ transactionsRepo: untouchable });

    const res = await get(app, "/stats?from=2020-01-01&to=2026-07-12");
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses a period holding more transactions than it will aggregate", async () => {
    // Always a full page with a further cursor, so the walk runs into its cap.
    const endless: TransactionsRepository = {
      ...fakeTransactions([]),
      async list() {
        return {
          items: Array.from({ length: 200 }, () => tx(1, "2026-07-08")),
          nextCursor: "cccccccc-cccc-4ccc-8ccc-000000000009",
        };
      },
    };
    const app = appWith({ transactionsRepo: endless });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PERIOD_TOO_LARGE");
    await app.close();
  });

  it("404s when the caller has no profile to denominate the total in", async () => {
    const app = appWith({ profile: null });

    const res = await get(app, `/stats?${WINDOW}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("401s without a token", async () => {
    const app = appWith({});
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  describe("query validation", () => {
    const badRequests: [string, string][] = [
      ["`from` after `to`", "from=2026-07-12&to=2026-07-06"],
      ["a date that does not exist", "from=2026-02-31&to=2026-03-05"],
      ["a malformed date", "from=yesterday"],
      ["a date-time with no zone designator", "from=2026-07-01T00:30:00"],
      ["an unknown parameter", "from=2026-07-06&groupBy=merchant"],
      ["a period wider than a year", "from=2026-01-01&to=2027-01-02"],
      // A lone `from` widens the window just as effectively as naming both ends.
      ["an open-ended period reaching back past the limit", "from=1900-01-01"],
    ];

    it.each(badRequests)("400s on %s", async (_label, query) => {
      const app = appWith({});
      const res = await get(app, `/stats?${query}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
      await app.close();
    });
  });
});
