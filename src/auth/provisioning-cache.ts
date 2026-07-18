// Keeps profile provisioning off the DB on the hot path. The auth preHandler
// calls `ensureProfile` on every authenticated request; without this, every
// request pays a DB roundtrip to re-confirm a row provisioned once.

import type { ProfileStore } from "./profile-store";

/**
 * Wrap a ProfileStore with a process-local memo of the user ids already
 * provisioned this process lifetime. Only the first request per user per process
 * reaches the inner store; the steady state does no DB work at all. A failed
 * inner call is not memoised, so it is retried on the next request.
 *
 * The set is bounded: on reaching `maxSize` it is cleared wholesale rather than
 * evicting one entry (cheap, and correctness holds because the inner upsert is
 * idempotent — a dropped id is simply re-provisioned on its next request).
 */
export function withProvisioningCache(inner: ProfileStore, maxSize = 10_000): ProfileStore {
  const provisioned = new Set<string>();
  return {
    async ensureProfile(userId) {
      if (provisioned.has(userId)) return;
      await inner.ensureProfile(userId);
      if (provisioned.size >= maxSize) provisioned.clear();
      provisioned.add(userId);
    },
  };
}
