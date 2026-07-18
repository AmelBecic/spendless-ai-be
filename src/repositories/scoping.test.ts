import { describe, it, expect } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createProfilesRepository } from "./profiles";
import { createFixedExpensesRepository } from "./fixed-expenses";
import { createTransactionsRepository } from "./transactions";
import { createSuggestionsRepository } from "./suggestions";
import { pageSize, toStringArray, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./shared";

// The isolation.integration.test.ts suite proves the behaviour against a real
// Postgres, but it skips without TEST_DATABASE_URL. This one needs no database:
// it records the query Prisma would have received and asserts the caller's
// `userId` is in the `where` (reads/writes) or the `data` (creates) of EVERY
// call. A method that forgot its scope fails here on every machine.

const USER = "11111111-1111-1111-1111-111111111111";

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** A Prisma delegate stand-in that records its arguments and returns `row`. */
function spyDelegate(calls: Call[], row: unknown): Record<string, unknown> {
  const record = (method: string) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    if (method === "findMany") return [row];
    if (method === "deleteMany" || method === "updateMany") return { count: 1 };
    return row;
  };
  return {
    findMany: record("findMany"),
    findFirst: record("findFirst"),
    findUnique: record("findUnique"),
    create: record("create"),
    update: record("update"),
    upsert: record("upsert"),
    deleteMany: record("deleteMany"),
  };
}

/** Every query a repository issues must pin the user in `where`, `data` or `create`. */
function assertScoped(calls: Call[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const where = call.args.where as Record<string, unknown> | undefined;
    const data = call.args.data as Record<string, unknown> | undefined;
    const create = call.args.create as Record<string, unknown> | undefined;
    const scoped = where?.userId === USER || data?.userId === USER || create?.userId === USER;
    expect(scoped, `${call.method} was issued without the user scope`).toBe(true);
  }
}

const profileRow = {
  userId: USER,
  currency: "EUR",
  timezone: "UTC",
  monthlyIncomeCents: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const expenseRow = {
  id: "e1",
  userId: USER,
  label: "Rent",
  categoryId: "c1",
  amountCents: 120_00,
  currency: "EUR",
  cadence: "monthly",
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const transactionRow = {
  id: "t1",
  userId: USER,
  amountCents: 42_00,
  currency: "EUR",
  categoryId: "c1",
  merchant: null,
  note: null,
  occurredAt: new Date(),
  createdAt: new Date(),
};

const suggestionRow = {
  id: "s1",
  userId: USER,
  asOfDate: new Date("2026-07-01T00:00:00.000Z"),
  text: "Cancel the bundle",
  categoryId: "c1",
  estMonthlySavingsCents: 15_00,
  currency: "EUR",
  rationale: "unused",
  sourceRefs: ["txn:1"],
  status: "new",
  createdAt: new Date(),
};

describe("repository user scoping", () => {
  it("profiles: every method pins the userId", async () => {
    const calls: Call[] = [];
    const repo = createProfilesRepository({
      userProfile: spyDelegate(calls, profileRow),
    } as unknown as Pick<PrismaClient, "userProfile">);

    await repo.ensure(USER);
    await repo.get(USER);
    await repo.update(USER, { currency: "USD" });

    assertScoped(calls);
  });

  it("expenses: every method pins the userId", async () => {
    const calls: Call[] = [];
    const repo = createFixedExpensesRepository({
      fixedExpense: spyDelegate(calls, expenseRow),
    } as unknown as Pick<PrismaClient, "fixedExpense">);

    await repo.list(USER);
    await repo.list(USER, { active: true });
    await repo.findById(USER, "e1");
    await repo.create(USER, {
      label: "Rent",
      categoryId: "c1",
      amountCents: 120_00,
      currency: "EUR",
      cadence: "monthly",
    });
    await repo.update(USER, "e1", { label: "Rent 2" });
    await repo.deactivate(USER, "e1");

    assertScoped(calls);
  });

  it("transactions: every method pins the userId", async () => {
    const calls: Call[] = [];
    const repo = createTransactionsRepository({
      transaction: spyDelegate(calls, transactionRow),
    } as unknown as Pick<PrismaClient, "transaction">);

    await repo.list(USER);
    await repo.list(USER, { from: new Date(), to: new Date(), categoryId: "c1", cursor: "t0" });
    await repo.findById(USER, "t1");
    await repo.create(USER, { amountCents: 1, currency: "EUR", categoryId: "c1" });
    await repo.update(USER, "t1", { amountCents: 2 });
    await repo.delete(USER, "t1");

    assertScoped(calls);
  });

  it("suggestions: every method pins the userId", async () => {
    const calls: Call[] = [];
    const repo = createSuggestionsRepository({
      suggestion: spyDelegate(calls, suggestionRow),
    } as unknown as Pick<PrismaClient, "suggestion">);

    await repo.list(USER);
    await repo.list(USER, { asOfDate: new Date(), status: "new" });
    await repo.findById(USER, "s1");
    await repo.create(USER, {
      asOfDate: new Date(),
      text: "x",
      estMonthlySavingsCents: 1,
      currency: "EUR",
      rationale: "y",
      sourceRefs: [],
    });
    await repo.setStatus(USER, "s1", "dismissed");

    assertScoped(calls);
  });

  // The input types carry no `userId`, but a handler forwarding an untyped
  // request body would bypass that at runtime. Both writing paths must build
  // `data` from known fields, so a smuggled `userId` can never reach Prisma —
  // on update that would let an owner reassign their row to another account.
  const OTHER = "22222222-2222-2222-2222-222222222222";
  const smuggled = { userId: OTHER, id: "forged", createdAt: new Date(0) };

  it("a create cannot be tricked into writing another user's id", async () => {
    const calls: Call[] = [];
    const repo = createTransactionsRepository({
      transaction: spyDelegate(calls, transactionRow),
    } as unknown as Pick<PrismaClient, "transaction">);

    await repo.create(USER, { amountCents: 1, currency: "EUR", categoryId: "c1", ...smuggled });

    const data = calls[0]?.args.data as Record<string, unknown>;
    expect(data.userId).toBe(USER);
    expect(data.id).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
  });

  it("an update cannot be tricked into reassigning the row to another user", async () => {
    const cases: { name: string; run: (calls: Call[]) => Promise<unknown> }[] = [
      {
        name: "transactions",
        run: (calls) =>
          createTransactionsRepository({
            transaction: spyDelegate(calls, transactionRow),
          } as unknown as Pick<PrismaClient, "transaction">).update(USER, "t1", {
            amountCents: 2,
            ...smuggled,
          }),
      },
      {
        name: "expenses",
        run: (calls) =>
          createFixedExpensesRepository({
            fixedExpense: spyDelegate(calls, expenseRow),
          } as unknown as Pick<PrismaClient, "fixedExpense">).update(USER, "e1", {
            label: "x",
            ...smuggled,
          }),
      },
      {
        name: "profiles",
        run: (calls) =>
          createProfilesRepository({
            userProfile: spyDelegate(calls, profileRow),
          } as unknown as Pick<PrismaClient, "userProfile">).update(USER, {
            currency: "USD",
            ...smuggled,
          }),
      },
      {
        name: "suggestions",
        run: (calls) =>
          createSuggestionsRepository({
            suggestion: spyDelegate(calls, suggestionRow),
          } as unknown as Pick<PrismaClient, "suggestion">).setStatus(USER, "s1", "dismissed"),
      },
    ];

    for (const { name, run } of cases) {
      const calls: Call[] = [];
      await run(calls);
      const data = calls[0]?.args.data as Record<string, unknown>;
      const where = calls[0]?.args.where as Record<string, unknown>;
      expect(data.userId, `${name} forwarded a smuggled userId into data`).toBeUndefined();
      expect(data.id, `${name} forwarded a smuggled id into data`).toBeUndefined();
      expect(where.userId, `${name} lost its user scope`).toBe(USER);
    }
  });
});

describe("profile provisioning under the first-request race", () => {
  const prismaError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "test" });

  function profilesWithFailingUpsert(err: unknown) {
    return createProfilesRepository({
      userProfile: {
        upsert: async () => {
          throw err;
        },
      },
    } as unknown as Pick<PrismaClient, "userProfile">);
  }

  it("treats a lost insert race (P2002) as success — the row exists either way", async () => {
    await expect(profilesWithFailingUpsert(prismaError("P2002")).ensure(USER)).resolves.toBeUndefined();
  });

  it("still surfaces any other database failure", async () => {
    // The P2002 catch must not become a blanket swallow.
    await expect(profilesWithFailingUpsert(prismaError("P1001")).ensure(USER)).rejects.toThrow();
    await expect(profilesWithFailingUpsert(new Error("connection lost")).ensure(USER)).rejects.toThrow(
      "connection lost",
    );
  });
});

describe("paging helpers", () => {
  it("defaults, clamps and truncates the page size", () => {
    expect(pageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(10)).toBe(10);
    expect(pageSize(0)).toBe(1);
    expect(pageSize(-5)).toBe(1);
    expect(pageSize(10_000)).toBe(MAX_PAGE_SIZE);
    expect(pageSize(10.7)).toBe(10);
  });

  it("reads a Json column back as a string array, ignoring non-strings", () => {
    expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(toStringArray(["a", 1, null])).toEqual(["a"]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray({ not: "an array" })).toEqual([]);
  });
});
