// Provisioning a user's profile row on first authenticated request. Kept behind
// an interface so the auth middleware can be unit-tested with a fake and no
// database.

import type { PrismaClient } from "@prisma/client";
import { createProfilesRepository } from "../repositories/profiles";

/**
 * Ensures a user's `UserProfile` row exists. Runs on every authenticated
 * request, so implementations MUST be idempotent: the first call provisions the
 * row, every later call is a no-op that leaves an existing row untouched.
 */
export interface ProfileStore {
  ensureProfile(userId: string): Promise<void>;
}

/**
 * Postgres-backed store, delegating to the profiles repository so provisioning
 * and the rest of the app share one writer (see repositories/profiles.ts for the
 * idempotency guarantee). Currency and timezone come from the schema defaults
 * (EUR / UTC). The per-request DB hit is elided in the steady state by
 * `withProvisioningCache` (see provisioning-cache.ts), not here — this stays a
 * dumb, correct writer.
 */
export function createPrismaProfileStore(
  prisma: Pick<PrismaClient, "userProfile">,
): ProfileStore {
  const profiles = createProfilesRepository(prisma);
  return {
    ensureProfile: (userId) => profiles.ensure(userId),
  };
}
