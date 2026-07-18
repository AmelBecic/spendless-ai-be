// The request-validation boundary. Every handler parses its input through here,
// so a malformed request becomes a 400 listing the offending fields *before* any
// repository method — and therefore any query — runs.

import type { ZodType } from "zod";
import { ValidationError, type FieldError } from "./errors";

/**
 * Flatten Zod's issues into the wire shape. Numeric path segments (array
 * indices) are joined with dots too — `items.0.amountCents` — which is enough
 * for a client to point at the field it got wrong.
 */
function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * Parse `value` against `schema`, or throw a `ValidationError` carrying every
 * failure at once — a client fixing a bad request should not have to discover
 * its problems one round trip at a time.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(toFieldErrors(parsed.error.issues), message);
  }
  return parsed.data;
}
