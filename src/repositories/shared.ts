// Plumbing shared by the repositories: paging shape, the not-found mapping, and
// the JSON reader. Nothing here knows about a specific model.

import { Prisma } from "@prisma/client";

/** A page of results plus the cursor for the next one (`null` when exhausted). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Clamp a caller-supplied page size into 1..MAX so a huge `limit` can't fan out. */
export function pageSize(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/**
 * Maps Prisma's "no row matched" (P2025) to `null`.
 *
 * Every scoped write below filters on `{ id, userId }`, so another user's row
 * matches nothing and is indistinguishable from a row that does not exist —
 * which is exactly what the caller (and the 404 it turns into) should see. The
 * repositories set foreign keys as plain scalars rather than `connect`, so P2025
 * from these calls can only mean the target row was missing or not owned.
 */
export async function nullIfNotFound<T>(op: Promise<T>): Promise<T | null> {
  try {
    return await op;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return null;
    }
    throw err;
  }
}

/** Read a Json column back as the `string[]` the domain type promises. */
export function toStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
