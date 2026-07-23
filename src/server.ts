// Process entrypoint: load env, open the DB pool, build the app, listen, and
// shut down cleanly. All the wiring the app itself stays ignorant of.

import "dotenv/config";
import { loadEnv } from "./config/env";
import { createPool, pingPool } from "./db/pool";
import { prisma } from "./db/client";
import { createSupabaseAuthVerifier, supabaseAuthEndpoints } from "./auth/verifier";
import { createPrismaProfileStore } from "./auth/profile-store";
import { withProvisioningCache } from "./auth/provisioning-cache";
import { createRepositories } from "./repositories";
import { createAnthropicLlmClient, type LlmLogger } from "./agent/anthropic";
import { startDailyRefreshJob } from "./agent/scheduler";
import { buildApp } from "./app";
import type { FastifyBaseLogger } from "fastify";

async function main(): Promise<void> {
  const config = loadEnv();
  // SUPABASE_URL alone identifies the project — the JWKS endpoint is derived
  // from it (see supabaseAuthEndpoints).
  if (!config.SUPABASE_URL) {
    throw new Error("SUPABASE_URL is required to verify auth tokens");
  }
  // ANTHROPIC_API_KEY is optional: without it the server starts in no-AI mode —
  // every money feature works and only the agent routes are gated (see buildApp).
  // A missing key is a deliberate mode, not a deployment mistake, so it must not
  // stop the process.
  const pool = createPool(config);
  const { issuer, jwksUrl } = supabaseAuthEndpoints(config.SUPABASE_URL, config.SUPABASE_JWKS_URL);
  const auth = {
    verifier: createSupabaseAuthVerifier({ jwksUrl, issuer }),
    profiles: withProvisioningCache(createPrismaProfileStore(prisma)),
  };
  const repos = createRepositories(prisma);

  // The LLM client wants a logger at construction time, but the app's logger
  // only exists once the app is built. Forwarding through a holder keeps the
  // model's cost accounting in the same stream as every other request log
  // rather than splitting it onto a second sink.
  const sink: { logger?: FastifyBaseLogger } = {};
  const llmLogger: LlmLogger = {
    info: (details, message) => sink.logger?.info(details, message),
    warn: (details, message) => sink.logger?.warn(details, message),
    error: (details, message) => sink.logger?.error(details, message),
  };
  // No key → no model client → no-AI mode. buildApp registers the agent routes to
  // return AI_DISABLED and reports `{ ai: false }` from /capabilities.
  const llm = config.ANTHROPIC_API_KEY
    ? createAnthropicLlmClient({ apiKey: config.ANTHROPIC_API_KEY, logger: llmLogger })
    : undefined;

  const app = buildApp({ config, db: { ping: () => pingPool(pool) }, auth, llm, repos });
  sink.logger = app.log;
  app.log.info(
    { aiEnabled: Boolean(llm) },
    llm ? "AI mode enabled" : "no ANTHROPIC_API_KEY — running in no-AI mode (money features only)",
  );

  // The in-process daily refresh. Opt-in: it is a background spender, so it must
  // not start just because someone ran the server with a real key in their .env.
  // Needs both the flag and a model client — in no-AI mode there is nothing to run.
  // Sprint 4 turns it on in the deployed environment.
  const refreshJob =
    config.DAILY_REFRESH_ENABLED && llm
      ? startDailyRefreshJob(
          { llm, ...repos, logger: app.log },
          { intervalMs: config.DAILY_REFRESH_INTERVAL_MINUTES * 60_000 },
        )
      : undefined;
  if (refreshJob) {
    app.log.info(
      { intervalMinutes: config.DAILY_REFRESH_INTERVAL_MINUTES },
      "daily refresh job started",
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    // Stopped before the app closes so a tick cannot start against a closing
    // pool and log a spurious failure on the way out.
    refreshJob?.stop();
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
