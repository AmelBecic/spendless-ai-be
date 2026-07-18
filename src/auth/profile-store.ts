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
 * Postgres-backed store. Reads first so the steady state (profile already
 * exists — the overwhelming majority of authenticated requests) is a single
 * indexed primary-key lookup, not a write. Only first sight falls through to an
 * upsert, which still guards the concurrent-first-request race; `update: {}`
 * deliberately does nothing so an existing profile is never reset. Currency and
 * timezone come from the schema defaults (EUR / UTC).
 */
export function createPrismaProfileStore(
  prisma: Pick<PrismaClient, "userProfile">,
): ProfileStore {
  return {
    async ensureProfile(userId) {
      const existing = await prisma.userProfile.findUnique({
        where: { userId },
        select: { userId: true },
      });
      if (existing) return;
      await prisma.userProfile.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
    },
  };
}
