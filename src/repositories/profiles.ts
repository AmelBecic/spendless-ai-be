// The caller's own settings row. `userId` is this table's primary key, so every
// method here is inherently single-user — there is no query shape that could
// reach another user's profile.

import type { PrismaClient, UserProfile as UserProfileRow } from "@prisma/client";
import type { UserProfile } from "../domain/types";
import { isUniqueViolation, nullIfNotFound } from "./shared";

/** The fields a user may change on their own profile. */
export interface ProfilePatch {
  currency?: string;
  timezone?: string;
  /** `null` clears a previously declared income. */
  monthlyIncomeCents?: number | null;
}

export interface ProfilesRepository {
  /**
   * Provision the caller's profile if absent. Idempotent: `update: {}` means a
   * repeat call leaves an existing row untouched. Postcondition on return: the
   * row exists.
   */
  ensure(userId: string): Promise<void>;
  get(userId: string): Promise<UserProfile | null>;
  /** Returns `null` if the profile does not exist. */
  update(userId: string, patch: ProfilePatch): Promise<UserProfile | null>;
}

function toDomain(row: UserProfileRow): UserProfile {
  return {
    userId: row.userId,
    currency: row.currency,
    timezone: row.timezone,
    // Income is denominated in the profile's own currency — there is no second
    // currency it could be in.
    monthlyIncome:
      row.monthlyIncomeCents === null
        ? undefined
        : { amountCents: row.monthlyIncomeCents, currency: row.currency },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createProfilesRepository(
  prisma: Pick<PrismaClient, "userProfile">,
): ProfilesRepository {
  return {
    async ensure(userId) {
      try {
        await prisma.userProfile.upsert({
          where: { userId },
          create: { userId },
          update: {},
        });
      } catch (err) {
        // Prisma only lowers `upsert` to a native ON CONFLICT statement in some
        // shapes; on the read-then-write path two concurrent first requests for
        // the same new user both see "no row" and the loser hits the unique
        // constraint. That loser's postcondition is still satisfied — the row
        // exists, someone else just inserted it — so this is success, not an error.
        if (!isUniqueViolation(err)) throw err;
      }
    },

    async get(userId) {
      const row = await prisma.userProfile.findUnique({ where: { userId } });
      return row ? toDomain(row) : null;
    },

    async update(userId, patch) {
      const row = await nullIfNotFound(
        prisma.userProfile.update({
          where: { userId },
          // Picked explicitly so an untyped request body forwarded by a handler
          // cannot reach `userId` or any column outside this list.
          data: {
            currency: patch.currency,
            timezone: patch.timezone,
            monthlyIncomeCents: patch.monthlyIncomeCents,
          },
        }),
      );
      return row ? toDomain(row) : null;
    },
  };
}
