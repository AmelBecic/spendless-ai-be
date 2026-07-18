import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { createRepositories, type Repositories } from "./index";

// The isolation seam (SLAI-7), proved against a real Postgres: user B holds a row
// of every kind, and user A tries to read, update and delete each one by id. A
// must get "empty / not found" every time — and B's row must still be intact
// afterwards, since a repository that silently wrote to the wrong row would
// otherwise pass a null-return assertion.
describe.skipIf(!hasTestDatabase)("per-user repository isolation", () => {
  const userA = "00000000-0000-0000-0000-00000000000a";
  const userB = "00000000-0000-0000-0000-00000000000b";

  let repos: Repositories;
  let categoryId: string;

  beforeEach(async () => {
    await resetDb();
    repos = createRepositories(testDb());
    await repos.profiles.ensure(userA);
    await repos.profiles.ensure(userB);
    const category = await testDb().category.create({
      data: { key: "groceries", label: "Groceries" },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("fixed expenses", () => {
    const expense = (label: string) => ({
      label,
      categoryId,
      amountCents: 120_00,
      currency: "EUR",
      cadence: "monthly" as const,
    });

    it("A cannot read B's expense — by id or in a listing", async () => {
      const bs = await repos.expenses.create(userB, expense("B's rent"));

      expect(await repos.expenses.findById(userA, bs.id)).toBeNull();
      expect(await repos.expenses.list(userA)).toEqual([]);
      // B still sees it — the empty result is scoping, not a failed write.
      expect(await repos.expenses.findById(userB, bs.id)).not.toBeNull();
    });

    it("A cannot update or deactivate B's expense", async () => {
      const bs = await repos.expenses.create(userB, expense("B's rent"));

      expect(await repos.expenses.update(userA, bs.id, { label: "hijacked" })).toBeNull();
      expect(await repos.expenses.deactivate(userA, bs.id)).toBeNull();

      const after = await repos.expenses.findById(userB, bs.id);
      expect(after?.label).toBe("B's rent");
      expect(after?.active).toBe(true);
    });

    it("a listing returns only the caller's rows when both users have some", async () => {
      await repos.expenses.create(userA, expense("A's gym"));
      await repos.expenses.create(userB, expense("B's rent"));

      const listed = await repos.expenses.list(userA);
      expect(listed.map((e) => e.label)).toEqual(["A's gym"]);
      expect(listed.every((e) => e.userId === userA)).toBe(true);
    });
  });

  describe("transactions", () => {
    const txn = (merchant: string) => ({
      amountCents: 42_00,
      currency: "EUR",
      categoryId,
      merchant,
      occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    it("A cannot read B's transaction — by id or in a listing", async () => {
      const bs = await repos.transactions.create(userB, txn("B's shop"));

      expect(await repos.transactions.findById(userA, bs.id)).toBeNull();
      expect((await repos.transactions.list(userA)).items).toEqual([]);
      expect(await repos.transactions.findById(userB, bs.id)).not.toBeNull();
    });

    it("A cannot update B's transaction", async () => {
      const bs = await repos.transactions.create(userB, txn("B's shop"));

      expect(await repos.transactions.update(userA, bs.id, { amountCents: 1 })).toBeNull();

      const after = await repos.transactions.findById(userB, bs.id);
      expect(after?.money.amountCents).toBe(42_00);
    });

    it("A cannot delete B's transaction", async () => {
      const bs = await repos.transactions.create(userB, txn("B's shop"));

      expect(await repos.transactions.delete(userA, bs.id)).toBe(false);
      expect(await repos.transactions.findById(userB, bs.id)).not.toBeNull();

      // The owner can, so `false` above is the scope talking, not a broken delete.
      expect(await repos.transactions.delete(userB, bs.id)).toBe(true);
      expect(await repos.transactions.findById(userB, bs.id)).toBeNull();
    });

    it("a cursor taken from B's rows still cannot page A into them", async () => {
      const bs = await repos.transactions.create(userB, txn("B's shop"));
      await repos.transactions.create(userA, txn("A's shop"));

      const page = await repos.transactions.list(userA, { cursor: bs.id, limit: 10 });
      expect(page.items.every((t) => t.userId === userA)).toBe(true);
    });

    it("a stale or malformed cursor yields an empty page, not a 500", async () => {
      await repos.transactions.create(userA, txn("A's shop"));

      // Well-formed but matching nothing (a row deleted since the page was
      // issued): Prisma resolves it positionally and returns nothing.
      const stale = await repos.transactions.list(userA, {
        cursor: "99999999-9999-9999-9999-999999999999",
      });
      expect(stale).toEqual({ items: [], nextCursor: null });

      // Not a uuid at all — Postgres cannot parse it (P2023). Client-supplied
      // junk must not become a server error.
      const malformed = await repos.transactions.list(userA, { cursor: "not-a-uuid" });
      expect(malformed).toEqual({ items: [], nextCursor: null });
    });

    it("pages deterministically and reports a next cursor", async () => {
      // Same occurredAt on every row, so only the id tiebreak makes paging stable.
      for (let i = 0; i < 5; i++) await repos.transactions.create(userA, txn(`shop-${i}`));

      const first = await repos.transactions.list(userA, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBe(first.items[1]?.id);

      const second = await repos.transactions.list(userA, { limit: 2, cursor: first.nextCursor! });
      expect(second.items).toHaveLength(2);

      const seen = [...first.items, ...second.items].map((t) => t.id);
      expect(new Set(seen).size).toBe(4); // no row served twice across pages

      const last = await repos.transactions.list(userA, { limit: 10 });
      expect(last.items).toHaveLength(5);
      expect(last.nextCursor).toBeNull(); // exhausted → no further page
    });

    it("date filtering does not widen the scope past the caller", async () => {
      await repos.transactions.create(userB, txn("B's shop"));

      const page = await repos.transactions.list(userA, {
        from: new Date("2020-01-01T00:00:00.000Z"),
        to: new Date("2030-01-01T00:00:00.000Z"),
      });
      expect(page.items).toEqual([]);
    });
  });

  describe("suggestions", () => {
    const suggestion = () => ({
      asOfDate: new Date("2026-07-01T00:00:00.000Z"),
      text: "Cancel the unused streaming bundle",
      categoryId,
      estMonthlySavingsCents: 15_00,
      currency: "EUR",
      rationale: "No usage recorded in 60 days",
      sourceRefs: ["txn:1", "stats:2026-07"],
    });

    it("A cannot read B's suggestion — by id or in a listing", async () => {
      const bs = await repos.suggestions.create(userB, suggestion());

      expect(await repos.suggestions.findById(userA, bs.id)).toBeNull();
      expect((await repos.suggestions.list(userA)).items).toEqual([]);
      expect(await repos.suggestions.findById(userB, bs.id)).not.toBeNull();
    });

    it("A cannot dismiss B's suggestion", async () => {
      const bs = await repos.suggestions.create(userB, suggestion());

      expect(await repos.suggestions.setStatus(userA, bs.id, "dismissed")).toBeNull();

      const after = await repos.suggestions.findById(userB, bs.id);
      expect(after?.status).toBe("new");
    });
  });

  describe("profiles", () => {
    it("A reads and writes only its own profile row", async () => {
      await repos.profiles.update(userB, { currency: "USD", timezone: "Europe/Sarajevo" });

      // A's read returns A's row, untouched by the write above.
      const as = await repos.profiles.get(userA);
      expect(as?.userId).toBe(userA);
      expect(as?.currency).toBe("EUR");

      // And A's write cannot reach B.
      await repos.profiles.update(userA, { currency: "GBP" });
      expect((await repos.profiles.get(userB))?.currency).toBe("USD");
    });

    it("update on an unprovisioned user returns null rather than creating a row", async () => {
      const stranger = "00000000-0000-0000-0000-0000000000ff";
      expect(await repos.profiles.update(stranger, { currency: "USD" })).toBeNull();
      expect(await repos.profiles.get(stranger)).toBeNull();
    });
  });
});
