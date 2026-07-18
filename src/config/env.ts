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
  SUPABASE_JWT_SECRET: optionalNonEmpty,
});

export type Env = z.infer<typeof EnvSchema>;

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
