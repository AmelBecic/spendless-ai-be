import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";

// Skips entirely when TEST_DATABASE_URL is unset (local runs without a DB); runs
// for real in CI against the ephemeral Postgres service.
describe.skipIf(!hasTestDatabase)("database integration", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("connects to the test database and round-trips a row", async () => {
    const db = testDb();
    await db.category.create({ data: { key: "groceries", label: "Groceries" } });
    expect(await db.category.count()).toBe(1);
  });

  it("resetDb truncates between tests", async () => {
    // beforeEach truncated, so the row created in the previous test is gone —
    // proving isolation actually happens rather than relying on ordering.
    expect(await testDb().category.count()).toBe(0);
  });
});
