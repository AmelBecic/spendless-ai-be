import { describe, it, expect } from "vitest";
import { buildApp } from "./app";
import type { Env } from "./config/env";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

// The health/404 paths don't touch auth; a stub keeps buildApp's contract satisfied.
const stubAuth = {
  verifier: { verify: async () => ({ id: "test-user" }) },
  profiles: { ensureProfile: async () => {} },
};

// Likewise for the repository seam — these paths never reach a route that reads it.
const stubRepos = { categories: { list: async () => [] } };

const appWith = (ping: () => Promise<void>) =>
  buildApp({ config: testConfig, db: { ping }, auth: stubAuth, repos: stubRepos });

describe("buildApp", () => {
  it("GET /health returns { status: 'ok' } when the DB is reachable", async () => {
    const app = appWith(async () => {});
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /health returns a 503 error envelope when the DB is unreachable", async () => {
    const app = appWith(async () => {
      throw new Error("down");
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: "DB_UNAVAILABLE", message: "database is not reachable" },
    });
    await app.close();
  });

  it("unknown routes return a 404 error envelope", async () => {
    const app = appWith(async () => {});
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    await app.close();
  });
});
