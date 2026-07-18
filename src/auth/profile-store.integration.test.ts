import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testDb, resetDb, disconnectTestDb } from "../test/db";
import { createPrismaProfileStore } from "./profile-store";

// Proves the provisioning contract against a real Postgres: first call inserts
// with schema defaults, later calls are no-ops. Skips when TEST_DATABASE_URL is
// unset (local runs without a DB); runs for real in CI.
describe.skipIf(!hasTestDatabase)("prisma profile provisioning", () => {
  const userId = "00000000-0000-0000-0000-000000000001";

  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("provisions a UserProfile on first sight with default currency + timezone", async () => {
    const store = createPrismaProfileStore(testDb());
    await store.ensureProfile(userId);

    const row = await testDb().userProfile.findUnique({ where: { userId } });
    expect(row).not.toBeNull();
    expect(row?.currency).toBe("EUR");
    expect(row?.timezone).toBe("UTC");
  });

  it("is idempotent: a repeat call adds no duplicate and does not reset the row", async () => {
    const store = createPrismaProfileStore(testDb());
    await store.ensureProfile(userId);
    // A later real request would have picked its own currency by now; prove the
    // second provisioning leaves that existing row alone rather than overwriting.
    await testDb().userProfile.update({ where: { userId }, data: { currency: "USD" } });

    await store.ensureProfile(userId);

    expect(await testDb().userProfile.count()).toBe(1);
    const row = await testDb().userProfile.findUnique({ where: { userId } });
    expect(row?.currency).toBe("USD");
  });
});
