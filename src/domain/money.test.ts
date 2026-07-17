import { describe, it, expect } from "vitest";
import { add, sum, format, MixedCurrencyError } from "./money";
import type { Money } from "./types";

const eur = (amountCents: number): Money => ({ amountCents, currency: "EUR" });
const usd = (amountCents: number): Money => ({ amountCents, currency: "USD" });

describe("add", () => {
  it("adds two amounts of the same currency", () => {
    expect(add(eur(150), eur(350))).toEqual(eur(500));
  });

  it("throws MixedCurrencyError on differing currencies", () => {
    expect(() => add(eur(100), usd(100))).toThrow(MixedCurrencyError);
  });

  it("throws on non-integer cents", () => {
    expect(() => add(eur(10.5), eur(1))).toThrow(TypeError);
  });
});

describe("sum", () => {
  it("sums a list of same-currency amounts", () => {
    expect(sum([eur(100), eur(200), eur(300)])).toEqual(eur(600));
  });

  it("returns a zero value for an empty list when a currency is given", () => {
    expect(sum([], "EUR")).toEqual(eur(0));
  });

  it("throws for an empty list with no currency to infer", () => {
    expect(() => sum([])).toThrow(/requires a currency/);
  });

  it("throws MixedCurrencyError if the list mixes currencies", () => {
    expect(() => sum([eur(100), usd(100)])).toThrow(MixedCurrencyError);
  });
});

describe("format", () => {
  it("formats EUR from integer cents", () => {
    // Non-breaking spaces vary by ICU build; assert on the parts that are stable.
    const out = format(eur(123456));
    expect(out).toContain("1,234.56");
    expect(out).toMatch(/€/);
  });

  it("formats USD from integer cents", () => {
    expect(format(usd(500))).toBe("$5.00");
  });

  it("throws on non-integer cents", () => {
    expect(() => format(eur(9.99))).toThrow(TypeError);
  });
});
