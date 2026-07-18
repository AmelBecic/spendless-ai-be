import type { FastifyInstance } from "fastify";
import type { Category } from "../domain/types";
import type { CategoriesRepository } from "../repositories/categories";

export interface CategoriesDeps {
  categories: CategoriesRepository;
}

/** The GET /categories response body. */
export interface CategoriesResponse {
  categories: Category[];
}

/**
 * GET /categories — the seeded category set, ordered by key.
 *
 * Authenticated: the list is not per-user, but it is part of the app's data
 * surface and stays behind the same bearer-token gate as everything else, so an
 * unauthenticated caller gets the standard 401 envelope from `authenticate`.
 */
export function registerCategoriesRoute(app: FastifyInstance, deps: CategoriesDeps): void {
  app.get(
    "/categories",
    { preHandler: app.authenticate },
    async (): Promise<CategoriesResponse> => {
      return { categories: await deps.categories.list() };
    },
  );
}
