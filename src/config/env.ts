// Typed environment configuration, validated once at boot. Anything that reads
// config imports `Env`; nothing reads `process.env` directly past this module.

import { z } from "zod";

// A blank ("" / whitespace) optional var is treated as absent rather than a
// validation failure — so vars that aren't wired up yet can sit empty in .env.
const optionalNonEmpty = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  // Postgres (Supabase). Required — the app cannot run without a database.
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  DIRECT_URL: optionalNonEmpty, // used by Prisma migrations (SLAI-4)
  // Supabase Auth / API. SUPABASE_URL + SUPABASE_JWKS_URL are required for JWT
  // verification (SLAI-6) and enforced at boot in server.ts; kept optional here
  // so tests and tooling can load a minimal env without them.
  SUPABASE_URL: optionalNonEmpty,
  SUPABASE_ANON_KEY: optionalNonEmpty,
  SUPABASE_JWKS_URL: optionalNonEmpty,
  // Anthropic API (SLAI-16). Server-side only — never reaches a client. Optional
  // here so tests and tooling load without it. `createAnthropicLlmClient` throws
  // on a blank key, so how early a keyless deploy fails depends on where the
  // client is constructed: nothing builds it yet, so today it would surface on
  // first use. SLAI-17 wires it into startup and should make this required then.
  ANTHROPIC_API_KEY: optionalNonEmpty,
  // Cost guardrails (SLAI-19). The refresh routes are the only ones where a
  // single request buys a paid completion, so they are metered per user.
  // Defaults are deliberately generous enough not to obstruct real use and tight
  // enough that a stuck client cannot run up a bill.
  REFRESH_RATE_LIMIT: z.coerce.number().int().nonnegative().default(10),
  REFRESH_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
  // The in-process daily refresh. Off by default: it is a background spender,
  // and a developer running the app locally against a real key should have to
  // opt in rather than discover it on their bill. Sprint 4 turns it on in deploy.
  DAILY_REFRESH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DAILY_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Every variable the app reads. `.env.example` must document exactly these —
 * enforced by env-example.test.ts so a new var can't ship undocumented.
 */
export const ENV_KEYS = Object.keys(EnvSchema.shape) as (keyof Env)[];

let cached: Env | undefined;

/**
 * Parse and validate the environment once. Throws a readable error listing every
 * invalid/missing variable so a misconfigured deploy fails fast at boot.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
