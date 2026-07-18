// Integration-test database harness.
//
// Integration tests run against a DISPOSABLE Postgres provided via
// TEST_DATABASE_URL — a Postgres service in CI, or a local/throwaway DB. When it
// is absent, integration suites skip (see `hasTestDatabase`) so `npm run test`
// still runs the unit tests with no database and no production credentials.

import { PrismaClient } from "@prisma/client";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const hasTestDatabase = Boolean(testDatabaseUrl);

let client: PrismaClient | undefined;

// Hard guard: resetDb() truncates every table, so refuse to point at anything
// that isn't obviously a disposable test database. The database NAME must contain
// "test" — the real Supabase database is named "postgres", so it is refused.
// (An equality check vs DATABASE_URL was deliberately dropped: in CI DATABASE_URL
// legitimately points at the same disposable test DB so the app singleton can be
// exercised, and the name check already covers the real-DB case.)
function assertDisposable(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(`TEST_DATABASE_URL database name "${dbName}" must contain "test" — refusing to truncate a non-test database`);
  }
}

/** The Prisma client bound to the (guarded) test database. */
export function testDb(): PrismaClient {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");
  if (!client) {
    assertDisposable(testDatabaseUrl);
    client = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  }
  return client;
}

/**
 * Truncate every app table for test isolation. The table list is read from the
 * database at run time (not hand-maintained) so new models are covered
 * automatically and can't silently leak rows between tests.
 */
export async function resetDb(): Promise<void> {
  const db = testDb();
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma_%'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

export async function disconnectTestDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
