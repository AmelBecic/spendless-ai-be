// Money helpers. Every operation works on integer cents and refuses to mix
// currencies — the two guarantees that keep spend totals correct everywhere.

import type { Money } from "./types";

/** Thrown when an operation would combine amounts in different currencies. */
export class MixedCurrencyError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine amounts in different currencies: ${a} and ${b}`);
    this.name = "MixedCurrencyError";
  }
}

function assertIntegerCents(m: Money): void {
  if (!Number.isInteger(m.amountCents)) {
    throw new TypeError(
      `Money.amountCents must be an integer number of cents, got ${m.amountCents}`,
    );
  }
}

/** Add two amounts. Throws if the currencies differ or either amount is non-integer. */
export function add(a: Money, b: Money): Money {
  assertIntegerCents(a);
  assertIntegerCents(b);
  if (a.currency !== b.currency) {
    throw new MixedCurrencyError(a.currency, b.currency);
  }
  return { amountCents: a.amountCents + b.amountCents, currency: a.currency };
}

/**
 * Sum a list of amounts.
 * - Non-empty: every item must share one currency (else `MixedCurrencyError`).
 * - Empty: returns a zero in `currency`; without a `currency` an empty sum throws,
 *   since there is nothing to infer it from.
 */
export function sum(items: Money[], currency?: string): Money {
  if (items.length === 0) {
    if (currency === undefined) {
      throw new Error("sum() of an empty list requires a currency for the zero value");
    }
    return { amountCents: 0, currency };
  }
  return items.reduce((acc, item) => add(acc, item));
}

/**
 * Format an amount for display. The cents→major-unit division happens only here,
 * at the presentation boundary — never in arithmetic.
 */
export function format(m: Money, locale = "en-US"): string {
  assertIntegerCents(m);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
  }).format(m.amountCents / 100);
}
