// Per-user rate limiting for the routes that cost money to serve.
//
// The LLM-backed refresh routes are the only endpoints where one request buys a
// paid completion, so an authenticated caller looping on them spends real money
// at whatever rate their client can manage. This bounds that.
//
// In-process and per-instance: the counter lives in this process's memory, so N
// instances allow N times the limit. That is a deliberate trade for the sprint —
// a shared counter needs Redis, which is infrastructure this sprint explicitly
// does not take on (deploy wiring is Sprint 4). It is a cost guardrail, not a
// security control; the ceiling it enforces is "one user cannot bankrupt us by
// holding down a button", not a precise quota.

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { requireUser } from "../auth/plugin";
import { AppError } from "./errors";

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the window resets — the `Retry-After` value. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Record an attempt for `key` and say whether it may proceed. */
  check(key: string, now: number): RateLimitDecision;
}

export interface RateLimiterOptions {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /**
   * Ceiling on tracked keys, so the map cannot grow without bound on a stream of
   * distinct users. Defaults to 10k — a few hundred KB.
   */
  maxKeys?: number;
}

interface Window {
  count: number;
  /** Epoch ms at which this window expires and the count resets. */
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * A fixed-window counter per key.
 *
 * Fixed rather than sliding: a sliding window needs the timestamps of every
 * request in it, and the thing being limited here is a handful of calls per
 * hour. The known artefact is that a caller can spend two windows' worth across
 * a window boundary — at these limits that is a few extra completions once an
 * hour, which is well inside what this is protecting against.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, maxKeys = DEFAULT_MAX_KEYS } = options;
  const windows = new Map<string, Window>();

  /**
   * Keep the map bounded.
   *
   * Expired entries go first: they are dead weight and dropping one changes no
   * decision. Only if that frees nothing is a live entry evicted — and then it
   * is the one with the *latest* reset, i.e. the most recently started window.
   *
   * That direction is the whole point, and it is counter-intuitive. Evicting the
   * oldest window is the obvious LRU-ish choice and it is a bypass: a caller who
   * has spent their budget need only push `maxKeys` distinct keys through the
   * limiter to evict their own counter and get a fresh allowance, and their
   * counter — being the longest-lived — is precisely the first one an
   * oldest-first policy drops. Evicting the newest instead means a flood
   * displaces only itself, and an established counter survives it.
   *
   * The cost is that under sustained overflow a brand-new key can be evicted
   * before it accumulates anything, so newcomers are effectively unmetered while
   * the map is saturated. That is the better failure: it under-limits strangers
   * rather than forgiving the one caller actively hammering a paid route.
   *
   * Deliberately not a wholesale `clear()`, which would reset every live counter
   * at once and hand every current caller a fresh budget.
   */
  function evictIfFull(now: number): void {
    if (windows.size < maxKeys) return;

    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
    if (windows.size < maxKeys) return;

    let newestKey: string | undefined;
    let newestResetAt = -Infinity;
    for (const [key, window] of windows) {
      if (window.resetAt > newestResetAt) {
        newestResetAt = window.resetAt;
        newestKey = key;
      }
    }
    if (newestKey !== undefined) windows.delete(newestKey);
  }

  return {
    check(key, now) {
      const existing = windows.get(key);

      if (!existing || existing.resetAt <= now) {
        evictIfFull(now);
        windows.set(key, { count: 1, resetAt: now + windowMs });
        // A limit of 0 disables the route outright rather than silently allowing
        // the first call through.
        return { allowed: limit > 0, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      }

      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      if (existing.count >= limit) {
        // Not incremented past the limit: counting rejected attempts would let a
        // caller who keeps hammering push their own reset further out only if
        // the window were sliding, but leaving it flat also keeps the number
        // meaning "requests served".
        return { allowed: false, retryAfterSeconds };
      }

      existing.count += 1;
      return { allowed: true, retryAfterSeconds };
    },
  };
}

/**
 * Fastify `preHandler` enforcing `limiter` per authenticated user.
 *
 * Registered *after* `app.authenticate` on each route so `requireUser` always
 * has an identity: limiting an unauthenticated request would key every anonymous
 * caller onto one bucket, letting any one of them lock out the rest.
 */
export function rateLimitByUser(limiter: RateLimiter, scope: string): preHandlerHookHandler {
  return async function enforce(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = requireUser(req);
    const decision = limiter.check(`${scope}:${user.id}`, Date.now());
    if (decision.allowed) return;

    void reply.header("Retry-After", String(decision.retryAfterSeconds));
    // Thrown, not sent: the app's error handler owns the response envelope, so
    // this 429 comes back in the same `{ error: { code, message } }` shape as
    // every other failure rather than a bespoke body.
    throw new AppError(
      429,
      "RATE_LIMITED",
      `too many ${scope} requests — retry in ${decision.retryAfterSeconds}s`,
    );
  };
}
