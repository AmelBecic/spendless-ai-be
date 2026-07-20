// The caller's own settings row. `userId` is this table's primary key, so every
// request-scoped method here is inherently single-user — there is no query shape
// a caller could bend to reach another user's profile.
//
// `listUserIds` is the one deliberate exception, and it is not request-scoped:
// the daily refresh job acts on behalf of no caller, so it needs the roster of
// users to walk. It returns ids and nothing else — no profile fields cross the
// boundary — and no route may call it. Everything a route reaches stays scoped
// to `req.user.id` exactly as before.

import type { PrismaClient, UserProfile as UserProfileRow } from "@prisma/client";
import type { UserProfile } from "../domain/types";
import { isUniqueViolation, nullIfNotFound, pageSize, type Page } from "./shared";

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
  /**
   * One page of user ids, for the scheduled refresh to walk. **Not for routes** —
   * see the note at the top of this file.
   *
   * Cursor-paged over the primary key: this table grows with signups, so an
   * unpaged read is a slow leak that only shows up once the product works. The
   * cursor is the last id of the previous page and the order is `userId asc`,
   * which is total (it is the primary key) and so cannot skip or repeat a row
   * mid-walk the way a timestamp ordering could.
   */
  listUserIds(options?: ListUserIdsOptions): Promise<Page<string>>;
}

export interface ListUserIdsOptions {
  /** Clamped to 1..200; defaults to 50. */
  limit?: number;
  /** The last id of the previous page. */
  cursor?: string;
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

    async listUserIds(options = {}) {
      const size = pageSize(options.limit);
      const rows = await prisma.userProfile.findMany({
        // Ids only: the scheduler loads what it needs per user through the
        // scoped repositories, so no profile field needs to travel with them.
        select: { userId: true },
        orderBy: { userId: "asc" },
        // One extra row says whether a further page exists, with no count query.
        take: size + 1,
        ...(options.cursor ? { cursor: { userId: options.cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, size).map((row) => row.userId);
      return {
        items: page,
        nextCursor: rows.length > size ? (page.at(-1) ?? null) : null,
      };
    },
  };
}
