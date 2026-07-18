import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { CATEGORIES } from "../domain/categories";
import { createCategoriesRepository } from "./categories";

// Proves the endpoint's data source against a real Postgres: the full seeded set
// comes back, mapped to the domain shape, in an order that does not depend on how
// the rows happened to be inserted.
describe.skipIf(!hasTestDatabase)("categories repository", () => {
  beforeEach(async () => {
    await resetDb();
    // Inserted in reverse of the canonical order so a test that passes only
    // because Postgres returned rows in insertion order would fail here.
    await testDb().category.createMany({
      data: [...CATEGORIES].reverse().map(({ key, label }) => ({ key, label })),
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns every seeded category ordered by key", async () => {
    const repo = createCategoriesRepository(testDb());
    const result = await repo.list();

    const expectedKeys = [...CATEGORIES].map((c) => c.key).sort();
    expect(result.map((c) => c.key)).toEqual(expectedKeys);
  });

  it("maps rows to the domain shape — id, key, label and nothing else", async () => {
    const repo = createCategoriesRepository(testDb());
    const [first] = await repo.list();

    expect(Object.keys(first!).sort()).toEqual(["id", "key", "label"]);
    expect(first!.id).toEqual(expect.any(String));
    expect(first!.label).toBe(CATEGORIES.find((c) => c.key === first!.key)?.label);
  });

  it("is stable — repeated calls return the same order", async () => {
    const repo = createCategoriesRepository(testDb());
    const [a, b] = await Promise.all([repo.list(), repo.list()]);

    expect(a).toEqual(b);
  });
});
