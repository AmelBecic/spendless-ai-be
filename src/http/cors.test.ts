// CORS is the one thing standing between the web client and every endpoint, and
// it fails in exactly two directions: too open (any site can call the API with
// the user's session) or too closed (the client's preflight dies and nothing
// works). Both paths are asserted here against a real app.

import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import { CORS_ALLOWED_METHODS } from "./cors";
import { EnvSchema } from "../config/env";
import { testEnv, unusedLlm, unusedRepos } from "../test/stubs";

const ALLOWED = "http://localhost:3001";
const REJECTED = "http://evil.example";

/**
 * An app whose auth verifier records every call. A preflight that reaches it has
 * already failed the contract — `OPTIONS` carries no `Authorization` header, so
 * the browser would see a 401 and never send the real request.
 */
function appWithCors(origins: string[]) {
  const verifyCalls: string[] = [];
  const app = buildApp({
    config: testEnv({ CORS_ALLOWED_ORIGINS: origins }),
    db: { ping: async () => {} },
    auth: {
      verifier: {
        verify: async (token: string) => {
          verifyCalls.push(token);
          return { id: "test-user" };
        },
      },
      profiles: { ensureProfile: async () => {} },
    },
    llm: unusedLlm,
    repos: unusedRepos,
  });
  return { app, verifyCalls };
}

/** Every CORS header a response could carry, so "none of them" is checkable. */
function corsHeaders(headers: Record<string, unknown>): string[] {
  return Object.keys(headers).filter((name) => name.toLowerCase().startsWith("access-control-"));
}

describe("CORS", () => {
  it("answers a preflight on an authenticated route without invoking auth", async () => {
    const { app, verifyCalls } = appWithCors([ALLOWED]);

    const res = await app.inject({
      method: "OPTIONS",
      url: "/transactions",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
    // The point of the bullet: the guard never ran.
    expect(verifyCalls).toEqual([]);

    await app.close();
  });

  it("reflects the allowed origin on a real request", async () => {
    const { app } = appWithCors([ALLOWED]);

    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");

    await app.close();
  });

  it("sends no CORS headers at all to a rejected origin's preflight", async () => {
    const { app, verifyCalls } = appWithCors([ALLOWED]);

    const res = await app.inject({
      method: "OPTIONS",
      url: "/transactions",
      headers: {
        origin: REJECTED,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    // Not merely a missing Allow-Origin: an unknown caller learns nothing about
    // which methods or headers the API accepts either.
    expect(corsHeaders(res.headers)).toEqual([]);
    expect(verifyCalls).toEqual([]);

    await app.close();
  });

  it("sends no CORS headers to a rejected origin's real request", async () => {
    const { app } = appWithCors([ALLOWED]);

    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: REJECTED } });

    // The response itself still succeeds — CORS is enforced by the browser, and
    // withholding the header is what makes it discard this.
    expect(res.statusCode).toBe(200);
    expect(corsHeaders(res.headers)).toEqual([]);

    await app.close();
  });

  it("allows nothing when the list is empty", async () => {
    const { app } = appWithCors([]);

    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED } });

    expect(corsHeaders(res.headers)).toEqual([]);

    await app.close();
  });

  it("leaves a request with no Origin header untouched", async () => {
    const { app } = appWithCors([ALLOWED]);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(corsHeaders(res.headers)).toEqual([]);

    await app.close();
  });

  it("serves several origins from the one list", async () => {
    const second = "https://spendless.example";
    const { app } = appWithCors([ALLOWED, second]);

    for (const origin of [ALLOWED, second]) {
      const res = await app.inject({ method: "GET", url: "/health", headers: { origin } });
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }

    await app.close();
  });
});

describe("CORS_ALLOWED_METHODS", () => {
  // The allow-list is written by hand and the router is not consulted, so the
  // two drift the moment a route is added with a method nobody thought about.
  // That failure is invisible server-side — the request is simply never sent by
  // the browser — so it has to be caught here.
  it("covers every method the router actually serves", async () => {
    const { app } = appWithCors([ALLOWED]);
    await app.ready();

    // `printRoutes` is the only public view of the assembled table. Each line
    // carries its methods in parentheses: `/transactions (GET, HEAD, POST)`.
    const routed = new Set(
      [...app.printRoutes({ commonPrefix: false }).matchAll(/\(([A-Z, ]+)\)/g)].flatMap((match) =>
        (match[1] ?? "").split(",").map((method) => method.trim()),
      ),
    );

    // Guards the parse itself: a regex that silently matched nothing would make
    // the assertion below vacuously true.
    expect(routed.size).toBeGreaterThan(3);
    expect([...routed].filter((method) => !CORS_ALLOWED_METHODS.includes(method))).toEqual([]);

    await app.close();
  });

  it("advertises those methods on a preflight", async () => {
    const { app } = appWithCors([ALLOWED]);

    const res = await app.inject({
      method: "OPTIONS",
      url: "/transactions",
      headers: { origin: ALLOWED, "access-control-request-method": "HEAD" },
    });

    const advertised = String(res.headers["access-control-allow-methods"])
      .split(",")
      .map((method) => method.trim());
    expect(advertised).toEqual(CORS_ALLOWED_METHODS);

    await app.close();
  });
});

describe("CORS_ALLOWED_ORIGINS", () => {
  const parse = (value: string) =>
    EnvSchema.safeParse({ DATABASE_URL: "postgres://test", CORS_ALLOWED_ORIGINS: value });

  it("splits a comma-separated list and trims each entry", () => {
    const result = parse(` ${ALLOWED} , https://spendless.example `);
    expect(result.success && result.data.CORS_ALLOWED_ORIGINS).toEqual([
      ALLOWED,
      "https://spendless.example",
    ]);
  });

  it("defaults to an empty list", () => {
    const result = EnvSchema.safeParse({ DATABASE_URL: "postgres://test" });
    expect(result.success && result.data.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  // Each of these would otherwise fail as a silent deny at request time — the
  // browser compares `Origin` for exact equality — so they fail at boot instead.
  it.each([
    ["a wildcard", "*"],
    ["a trailing slash", "http://localhost:3001/"],
    ["a path", "http://localhost:3001/app"],
    ["a non-http scheme", "ws://localhost:3001"],
    ["a bare host", "localhost:3001"],
  ])("rejects %s", (_label, value) => {
    expect(parse(value).success).toBe(false);
  });
});
