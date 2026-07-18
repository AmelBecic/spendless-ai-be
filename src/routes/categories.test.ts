import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import type { Category } from "../domain/types";
import type { CategoriesRepository } from "../repositories/categories";
import type { AuthDeps } from "../auth/plugin";
import { AppError } from "../http/errors";
import { unusedFixedExpenses, unusedTransactions } from "../test/stubs";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

// Token verification itself is covered in auth/auth.test.ts; here the verifier is
// a stub that either accepts or rejects, so these tests stay about the route.
const acceptingAuth: AuthDeps = {
  verifier: { verify: async () => ({ id: "user-1" }) },
  profiles: { ensureProfile: async () => {} },
};

const seeded: Category[] = [
  { id: "11111111-1111-1111-1111-111111111111", key: "dining", label: "Dining" },
  { id: "22222222-2222-2222-2222-222222222222", key: "groceries", label: "Groceries" },
];

function appWith(categories: CategoriesRepository, auth = acceptingAuth) {
  return buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth,
    repos: { categories, expenses: unusedFixedExpenses, transactions: unusedTransactions },
  });
}

const stubRepo = (items: Category[]): CategoriesRepository => ({ list: async () => items });

describe("GET /categories", () => {
  it("returns the seeded categories in the repository's order", async () => {
    const app = appWith(stubRepo(seeded));
    const res = await app.inject({
      method: "GET",
      url: "/categories",
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.statusCode).toBe(200);
    // Order is asserted, not just membership — "stable ordering" is the AC.
    expect(res.json()).toEqual({ categories: seeded });
    await app.close();
  });

  it("returns an empty list rather than an error when nothing is seeded", async () => {
    const app = appWith(stubRepo([]));
    const res = await app.inject({
      method: "GET",
      url: "/categories",
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ categories: [] });
    await app.close();
  });

  it("rejects an unauthenticated request with the 401 envelope", async () => {
    let listed = false;
    const app = appWith({
      list: async () => {
        listed = true;
        return seeded;
      },
    });
    const res = await app.inject({ method: "GET", url: "/categories" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    // The guard runs before the handler — no query is issued for a rejected caller.
    expect(listed).toBe(false);
    await app.close();
  });

  it("rejects a request whose token fails verification", async () => {
    const rejecting: AuthDeps = {
      verifier: {
        verify: async () => {
          throw new AppError(401, "UNAUTHORIZED", "bad token");
        },
      },
      profiles: { ensureProfile: async () => {} },
    };
    const app = appWith(stubRepo(seeded), rejecting);
    const res = await app.inject({
      method: "GET",
      url: "/categories",
      headers: { authorization: "Bearer bad-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
