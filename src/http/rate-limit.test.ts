// The limiter's own arithmetic, driven by an injected clock so a window can be
// crossed without waiting for one.

import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  const WINDOW = 60_000;

  it("allows exactly `limit` requests in a window, then refuses", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: WINDOW });

    const verdicts = [0, 1, 2, 3, 4].map((i) => limiter.check("user", 1000 + i).allowed);

    expect(verdicts).toEqual([true, true, true, false, false]);
  });

  it("starts a fresh window once the previous one expires", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW });

    expect(limiter.check("user", 0).allowed).toBe(true);
    expect(limiter.check("user", WINDOW - 1).allowed).toBe(false);
    // The window is closed at exactly `resetAt`, not one tick later — an
    // off-by-one here would hold a caller out for a whole extra window.
    expect(limiter.check("user", WINDOW).allowed).toBe(true);
  });

  it("meters each key independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW });

    expect(limiter.check("alice", 0).allowed).toBe(true);
    expect(limiter.check("alice", 1).allowed).toBe(false);
    // Alice exhausting her budget must not spend Bob's.
    expect(limiter.check("bob", 1).allowed).toBe(true);
  });

  it("reports whole seconds until the window resets", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW });
    limiter.check("user", 0);

    const decision = limiter.check("user", 30_500);

    expect(decision.allowed).toBe(false);
    // 29.5s remaining rounds up: telling a caller to retry in 29 would have them
    // arrive half a second early and get another 429.
    expect(decision.retryAfterSeconds).toBe(30);
  });

  it("never reports a retry of zero seconds", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW });
    limiter.check("user", 0);

    // 0.4s remaining would floor to 0, telling the client to retry immediately.
    expect(limiter.check("user", WINDOW - 400).retryAfterSeconds).toBe(1);
  });

  it("treats a limit of zero as closed rather than allowing the first call", () => {
    const limiter = createRateLimiter({ limit: 0, windowMs: WINDOW });

    expect(limiter.check("user", 0).allowed).toBe(false);
  });

  it("bounds the key map without handing live callers a fresh allowance", () => {
    // The eviction path is the one that could quietly become a bypass: a
    // wholesale clear on overflow would reset every counter at once, so a caller
    // already at their limit gets a new window for free just because unrelated
    // traffic arrived. Fill past the ceiling with distinct keys and assert the
    // exhausted caller is *still* refused.
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 4 });

    expect(limiter.check("victim", 0).allowed).toBe(true);
    expect(limiter.check("victim", 1).allowed).toBe(false);

    for (let i = 0; i < 50; i += 1) limiter.check(`filler-${i}`, 2);

    expect(limiter.check("victim", 3).allowed).toBe(false);
  });

  it("reclaims expired keys so a long-lived process does not grow forever", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 4 });

    for (let i = 0; i < 4; i += 1) limiter.check(`old-${i}`, 0);

    // Every entry above has expired by now, so a new key is admitted and gets a
    // full window rather than being squeezed out by dead weight.
    expect(limiter.check("fresh", WINDOW + 1).allowed).toBe(true);
    expect(limiter.check("fresh", WINDOW + 2).allowed).toBe(false);
  });
});
