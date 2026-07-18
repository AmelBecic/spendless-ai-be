// The authentication seam. Verifying a credential lives behind `AuthVerifier`
// so the provider (Supabase today) can be swapped without touching route or
// middleware code — and so tests can verify offline against a local key set
// instead of calling Supabase.

import { jwtVerify, createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { AppError } from "../http/errors";

/** The authenticated principal derived from a verified token. */
export interface AuthenticatedUser {
  /** Supabase `auth.users.id` — the JWT `sub` claim. */
  id: string;
}

/**
 * Verifies a bearer credential and yields the authenticated user, or throws a
 * 401 `AppError`. The single seam the rest of the app depends on.
 */
export interface AuthVerifier {
  verify(token: string): Promise<AuthenticatedUser>;
}

// Supabase issues end-user access tokens with `aud: "authenticated"` AND
// `role: "authenticated"`; anon/service credentials carry a different `role`.
const SUPABASE_AUDIENCE = "authenticated";
const SUPABASE_END_USER_ROLE = "authenticated";
// Asymmetric algorithms Supabase signs its JWTs with. Pinning the set rejects
// `alg: none` and algorithm-confusion attacks rather than trusting the header.
const SUPABASE_ALGORITHMS = ["ES256", "RS256"];

export interface JwtAuthVerifierOptions {
  /** Resolves the signing key for a token — a JWKS in production. */
  keys: JWTVerifyGetKey;
  /** Required `aud` claim. */
  audience: string;
  /** Required `iss` claim; when omitted the issuer is not checked. */
  issuer?: string;
  /**
   * Required `role` claim; when omitted the role is not checked. Distinguishes
   * an end-user token from anon/service credentials that share the audience.
   */
  expectedRole?: string;
  /** Permitted signing algorithms (defaults to Supabase's asymmetric set). */
  algorithms?: string[];
}

// A genuine token failure collapses to one opaque 401 so callers never learn
// which check failed (signature vs expiry vs audience) — the cause is retained
// for server-side logging via the app error handler.
const unauthorized = (cause: unknown) =>
  new AppError(401, "UNAUTHORIZED", "invalid or expired token", { cause });

// A failure to *reach* the signing keys (JWKS fetch/timeout) is an upstream
// outage, not a bad token — surface it as 503 so clients back off instead of
// force-logging-out every user during a Supabase/network incident.
const authUnavailable = (cause: unknown) =>
  new AppError(503, "AUTH_UNAVAILABLE", "authentication is temporarily unavailable", { cause });

// jose codes that mean "the keys couldn't be resolved" rather than "the token is
// bad". Every other jose error is token-level (401); a non-jose throw (e.g. a
// raw fetch rejection resolving the remote JWKS) is treated as infra (503).
const INFRA_ERROR_CODES = new Set<string>(["ERR_JWKS_TIMEOUT"]);

function classifyVerifyError(err: unknown): AppError {
  if (err instanceof errors.JOSEError) {
    return INFRA_ERROR_CODES.has(err.code) ? authUnavailable(err) : unauthorized(err);
  }
  return authUnavailable(err);
}

/**
 * A JWT verifier over a key resolver. `jose` enforces `exp`; audience and the
 * allowed algorithms are enforced here. Provider-agnostic: production passes a
 * Supabase JWKS, tests pass a local key set — the verification path is identical.
 */
export function createJwtAuthVerifier(opts: JwtAuthVerifierOptions): AuthVerifier {
  const algorithms = opts.algorithms ?? SUPABASE_ALGORITHMS;
  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, opts.keys, {
          audience: opts.audience,
          issuer: opts.issuer,
          algorithms,
        }));
      } catch (err) {
        throw classifyVerifyError(err);
      }
      // A validly-signed token from the wrong actor (anon/service) must not pass
      // as an end user even though the signature and audience check out.
      if (opts.expectedRole && payload.role !== opts.expectedRole) {
        throw unauthorized(new Error("unexpected role claim"));
      }
      // A token with no subject can't identify a user, so it is still unusable.
      const sub = payload.sub;
      if (!sub) throw unauthorized(new Error("token has no `sub` claim"));
      return { id: sub };
    },
  };
}

/**
 * The production verifier: checks Supabase access tokens against the project's
 * JWKS endpoint. `createRemoteJWKSet` fetches and caches the keys, so there is
 * no per-request network call in the steady state; the fetch is bounded by a
 * timeout and rate-limited by a cooldown so a slow/flapping endpoint can't hang
 * or hammer requests.
 */
export function createSupabaseAuthVerifier(opts: {
  jwksUrl: string;
  issuer?: string;
}): AuthVerifier {
  return createJwtAuthVerifier({
    keys: createRemoteJWKSet(new URL(opts.jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    }),
    audience: SUPABASE_AUDIENCE,
    issuer: opts.issuer,
    expectedRole: SUPABASE_END_USER_ROLE,
  });
}
