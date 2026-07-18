import { describe, it, expect } from "vitest";
import { withProvisioningCache } from "./provisioning-cache";
import type { ProfileStore } from "./profile-store";

/** An inner store that records every id it was asked to provision. */
function recording(): ProfileStore & { calls: string[] } {
  const calls: string[] = [];
  return { calls, ensureProfile: async (userId) => void calls.push(userId) };
}

describe("withProvisioningCache", () => {
  it("reaches the inner store once per user, then serves from the memo", async () => {
    const inner = recording();
    const store = withProvisioningCache(inner);
    await store.ensureProfile("a");
    await store.ensureProfile("a");
    await store.ensureProfile("b");
    await store.ensureProfile("a");
    expect(inner.calls).toEqual(["a", "b"]);
  });

  it("does not memoise a failed provisioning — it is retried next time", async () => {
    let failNext = true;
    const calls: string[] = [];
    const inner: ProfileStore = {
      ensureProfile: async (userId) => {
        calls.push(userId);
        if (failNext) {
          failNext = false;
          throw new Error("db down");
        }
      },
    };
    const store = withProvisioningCache(inner);
    await expect(store.ensureProfile("a")).rejects.toThrow("db down");
    await store.ensureProfile("a"); // retried because the failure wasn't cached
    await store.ensureProfile("a"); // now cached
    expect(calls).toEqual(["a", "a"]);
  });

  it("stays bounded: clears the memo once maxSize is reached", async () => {
    const inner = recording();
    const store = withProvisioningCache(inner, 2);
    await store.ensureProfile("a"); // memo {a}
    await store.ensureProfile("b"); // memo {a,b}
    await store.ensureProfile("c"); // size is 2 → cleared, then memo {c}
    await store.ensureProfile("a"); // "a" was dropped in the clear → reaches inner again
    expect(inner.calls).toEqual(["a", "b", "c", "a"]);
  });
});
