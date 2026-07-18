// Categories are the one deliberately *unscoped* repository: the category set is
// global reference data seeded from src/domain/categories.ts, identical for every
// user and owned by none. There is no `userId` column to filter on, so the
// isolation rule the other repositories enforce does not apply — and because the
// table is read-only from the API's point of view, an unscoped read leaks nothing.
// Writes stay with the seed script; this repository exposes reads only.

import type { PrismaClient, Category as CategoryRow } from "@prisma/client";
import type { Category } from "../domain/types";

export interface CategoriesRepository {
  /**
   * Every category, ordered by `key` — stable across calls and independent of
   * insertion order.
   *
   * Deliberately unpaged, unlike the per-user listings: this table does not grow
   * with use. It holds exactly the fixed set in src/domain/categories.ts (9 rows),
   * changed only by a deploy that edits that list and re-runs the seed. Paging a
   * bounded reference set would cost the client a round trip per page for nothing.
   */
  list(): Promise<Category[]>;
}

function toDomain(row: CategoryRow): Category {
  // Mapped field by field rather than spread, so a column added to the model
  // later (or a timestamp) cannot silently widen the API response.
  return { id: row.id, key: row.key, label: row.label };
}

export function createCategoriesRepository(
  prisma: Pick<PrismaClient, "category">,
): CategoriesRepository {
  return {
    async list() {
      // `key` is unique, so it is a total order — no tiebreak needed for determinism.
      const rows = await prisma.category.findMany({ orderBy: { key: "asc" } });
      return rows.map(toDomain);
    },
  };
}
