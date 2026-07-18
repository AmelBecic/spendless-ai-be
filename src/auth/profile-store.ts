// Provisioning a user's profile row on first authenticated request. Kept behind
// an interface so the auth middleware can be unit-tested with a fake and no
// database.

import type { PrismaClient } from "@prisma/client";

/**
 * Ensures a user's `UserProfile` row exists. Runs on every authenticated
 * request, so implementations MUST be idempotent: the first call provisions the
 * row, every later call is a no-op that leaves an existing row untouched.
 */
export interface ProfileStore {
  ensureProfile(userId: string): Promise<void>;
}

/**
 * Postgres-backed store. A single idempotent upsert: `INSERT ... ON CONFLICT DO
 * NOTHING`, so it's safe under the concurrent-first-request race and `update: {}`
 * never resets an existing profile. Currency and timezone come from the schema
 * defaults (EUR / UTC). The per-request DB hit is elided in the steady state by
 * `withProvisioningCache` (see provisioning-cache.ts), not here — this stays a
 * dumb, correct writer.
 */
export function createPrismaProfileStore(
  prisma: Pick<PrismaClient, "userProfile">,
): ProfileStore {
  return {
    async ensureProfile(userId) {
      await prisma.userProfile.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
    },
  };
}
