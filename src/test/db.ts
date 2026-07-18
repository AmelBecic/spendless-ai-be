// Integration-test database harness.
//
// Integration tests run against a DISPOSABLE Postgres provided via
// TEST_DATABASE_URL — a Postgres service in CI, or a local/throwaway DB for
// local runs. It is never the production/Supabase database. When TEST_DATABASE_URL
// is absent, integration suites skip (see `hasTestDatabase`) so `npm run test`
// still runs the unit tests with no database and no production credentials.

import { PrismaClient } from "@prisma/client";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const hasTestDatabase = Boolean(testDatabaseUrl);

let client: PrismaClient | undefined;

/** The Prisma client bound to the test database. */
export function testDb(): PrismaClient {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");
  client ??= new PrismaClient({ datasourceUrl: testDatabaseUrl });
  return client;
}

// Child tables first so CASCADE isn't strictly required, but keep it for safety.
const TABLES = [
  "suggestions",
  "profile_summaries",
  "transactions",
  "fixed_expenses",
  "categories",
  "user_profiles",
] as const;

/** Truncate every app table — call between tests for isolation. */
export async function resetDb(): Promise<void> {
  const db = testDb();
  const list = TABLES.map((t) => `"${t}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

export async function disconnectTestDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
