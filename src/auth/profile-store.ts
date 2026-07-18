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
 * Postgres-backed store. Uses an upsert so two concurrent first requests can't
 * race into duplicate inserts; currency and timezone come from the schema
 * defaults (EUR / UTC). `update: {}` deliberately does nothing — an existing
 * profile is never reset.
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
