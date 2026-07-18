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

/**
 * True for Prisma's "inconsistent column data" (P2023) — what Postgres raises
 * when a client-supplied cursor is not a well-formed uuid. A cursor that is
 * well-formed but matches nothing already yields an empty page, so callers treat
 * the unparseable case the same way instead of turning bad input into a 500.
 */
export function isMalformedCursor(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2023";
}

/** True for a unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Turn the `size + 1` rows a paged query fetches into a `Page`. The extra row is
 * the lookahead that says whether a further page exists; it is dropped from the
 * result and its predecessor's id becomes the next cursor.
 */
export function toPage<Row extends { id: string }, T>(
  rows: Row[],
  size: number,
  map: (row: Row) => T,
): Page<T> {
  const page = rows.slice(0, size);
  return {
    items: page.map(map),
    nextCursor: rows.length > size ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Read a Json column back as the `string[]` the domain type promises. */
export function toStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
