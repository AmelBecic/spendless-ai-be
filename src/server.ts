// Process entrypoint: load env, open the DB pool, build the app, listen, and
// shut down cleanly. All the wiring the app itself stays ignorant of.

import "dotenv/config";
import { loadEnv } from "./config/env";
import { createPool, pingPool } from "./db/pool";
import { prisma } from "./db/client";
import { createSupabaseAuthVerifier } from "./auth/verifier";
import { createPrismaProfileStore } from "./auth/profile-store";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.SUPABASE_JWKS_URL) {
    throw new Error("SUPABASE_JWKS_URL is required to verify auth tokens");
  }
  const pool = createPool(config);
  // Supabase's issuer is `<project-url>/auth/v1`; verify it when the URL is set.
  const issuer = config.SUPABASE_URL
    ? `${config.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`
    : undefined;
  const auth = {
    verifier: createSupabaseAuthVerifier({ jwksUrl: config.SUPABASE_JWKS_URL, issuer }),
    profiles: createPrismaProfileStore(prisma),
  };
  const app = buildApp({ config, db: { ping: () => pingPool(pool) }, auth });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    await app.close();
    await pool.end();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    await pool.end();
    process.exit(1);
  }
}

void main();
