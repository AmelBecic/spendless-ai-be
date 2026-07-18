import { describe, it, expect, beforeAll } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type CryptoKey,
  type JWK,
} from "jose";
import { buildApp } from "../app";
import type { Env } from "../config/env";
import { createJwtAuthVerifier, type AuthVerifier } from "./verifier";
import type { ProfileStore } from "./profile-store";

const testConfig: Env = { NODE_ENV: "test", PORT: 3000, DATABASE_URL: "postgres://test" };

const AUDIENCE = "authenticated";
const ISSUER = "https://proj.supabase.co/auth/v1";

// A key pair the tests sign with, plus a second "attacker" key that the verifier
// does NOT trust — used to prove a good-looking token with a bad signature fails.
let signingKey: CryptoKey;
let attackerKey: CryptoKey;
let verifier: AuthVerifier;

beforeAll(async () => {
  const trusted = await generateKeyPair("ES256");
  const attacker = await generateKeyPair("ES256");
  signingKey = trusted.privateKey;
  attackerKey = attacker.privateKey;

  const jwk: JWK = { ...(await exportJWK(trusted.publicKey)), kid: "test-key", alg: "ES256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  verifier = createJwtAuthVerifier({ keys: jwks, audience: AUDIENCE, issuer: ISSUER });
});

/** Mint a signed token, defaulting to a valid one; overrides exercise failures. */
function token(
  key: CryptoKey,
  opts: { sub?: string | null; aud?: string; expSeconds?: number } = {},
): Promise<string> {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expSeconds ?? 300));
  // sub: undefined omits it; a string sets it. `null` means "leave it out".
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? "user-123");
  return jwt.sign(key);
}

/** A profile store that records the ids it was asked to provision. */
function recordingProfiles(): ProfileStore & { calls: string[] } {
  const calls: string[] = [];
  return { calls, ensureProfile: async (userId) => void calls.push(userId) };
}

/** buildApp + a single protected route guarded by `app.authenticate`. */
function protectedApp(profiles: ProfileStore) {
  const app = buildApp({
    config: testConfig,
    db: { ping: async () => {} },
    auth: { verifier, profiles },
  });
  app.get("/me", { preHandler: app.authenticate }, async (req) => ({ id: req.user?.id }));
  return app;
}

const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

describe("authenticate preHandler", () => {
  it("accepts a valid token, sets req.user.id, and provisions the profile", async () => {
    const profiles = recordingProfiles();
    const app = protectedApp(profiles);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(await token(signingKey, { sub: "user-123" })),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "user-123" });
    expect(profiles.calls).toEqual(["user-123"]);
    await app.close();
  });

  it("provisions on every request (store makes it idempotent, not the middleware)", async () => {
    const profiles = recordingProfiles();
    const app = protectedApp(profiles);
    const headers = authHeader(await token(signingKey, { sub: "user-9" }));
    await app.inject({ method: "GET", url: "/me", headers });
    await app.inject({ method: "GET", url: "/me", headers });
    expect(profiles.calls).toEqual(["user-9", "user-9"]);
    await app.close();
  });

  it("rejects a missing Authorization header with the 401 envelope", async () => {
    const app = protectedApp(recordingProfiles());
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "missing or malformed Authorization header" },
    });
    await app.close();
  });

  it("rejects a malformed Authorization header (no Bearer scheme)", async () => {
    const app = protectedApp(recordingProfiles());
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: await token(signingKey) },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token signed by an untrusted key", async () => {
    const profiles = recordingProfiles();
    const app = protectedApp(profiles);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(await token(attackerKey)),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(profiles.calls).toEqual([]); // never provisioned for an unverified token
    await app.close();
  });

  it("rejects an expired token", async () => {
    const app = protectedApp(recordingProfiles());
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(await token(signingKey, { expSeconds: -60 })),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token with the wrong audience", async () => {
    const app = protectedApp(recordingProfiles());
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(await token(signingKey, { aud: "anon" })),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a validly-signed token that carries no subject", async () => {
    const app = protectedApp(recordingProfiles());
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(await token(signingKey, { sub: null })),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
