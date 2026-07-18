import { describe, it, expect } from "vitest";
import { CATEGORIES } from "./categories";

describe("CATEGORIES", () => {
  it("is the exact expected key set, in order", () => {
    expect(CATEGORIES.map((c) => c.key)).toEqual([
      "groceries",
      "dining",
      "transport",
      "rent",
      "utilities",
      "subscriptions",
      "entertainment",
      "health",
      "other",
    ]);
  });

  it("has no duplicate keys", () => {
    const keys = CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry has a non-empty label", () => {
    for (const c of CATEGORIES) expect(c.label.length).toBeGreaterThan(0);
  });
});
