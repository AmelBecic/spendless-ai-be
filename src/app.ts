// Builds the Fastify app with its error/response contract wired in. Kept separate
// from server.ts (which listens) so tests can drive it via `inject` — no port,
// no real database — by passing stub deps.

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Env } from "./config/env";
import { AppError, type ErrorBody } from "./http/errors";
import { registerAuth, type AuthDeps } from "./auth/plugin";
import { registerHealthRoute } from "./routes/health";
import { registerCategoriesRoute } from "./routes/categories";
import { registerFixedExpensesRoutes } from "./routes/fixed-expenses";
import { registerTransactionsRoutes } from "./routes/transactions";
import { registerStatsRoute } from "./routes/stats";
import { registerProfileRoutes } from "./routes/profile";
import { registerSuggestionsRoutes } from "./routes/suggestions";
import type { CategoriesRepository } from "./repositories/categories";
import type { FixedExpensesRepository } from "./repositories/fixed-expenses";
import type { TransactionsRepository } from "./repositories/transactions";
import type { ProfilesRepository } from "./repositories/profiles";
import type { ProfileSummariesRepository } from "./repositories/profile-summaries";
import type { SuggestionsRepository } from "./repositories/suggestions";
import type { AgentRunsRepository } from "./repositories/agent-runs";
import type { LlmClient } from "./agent/anthropic";
import { createRateLimiter, rateLimitByUser } from "./http/rate-limit";
import { registerCors } from "./http/cors";

export interface AppDeps {
  config: Env;
  db: { ping: () => Promise<void> };
  auth: AuthDeps;
  /** The model seam the agent routes run on — an interface, never the SDK. */
  llm: LlmClient;
  /** The data-access seam routes read through. Narrowed to what the registered routes need. */
  repos: {
    categories: CategoriesRepository;
    expenses: FixedExpensesRepository;
    transactions: TransactionsRepository;
    profiles: ProfilesRepository;
    summaries: ProfileSummariesRepository;
    suggestions: SuggestionsRepository;
    agentRuns: AgentRunsRepository;
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.config.NODE_ENV !== "test" });

  // Fastify's built-in JSON parser rejects an empty body outright, which turns an
  // ordinary `DELETE /x -H 'content-type: application/json'` — what most HTTP
  // clients send by default, body or not — into a 500. Treat an empty body as
  // "no body" and let each route's schema decide: bodyless routes ignore it, and
  // a POST that needs one still fails validation with a 400 naming its fields.
  app.addContentTypeParser<string>(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body.trim() === "") return done(null, undefined);
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(new AppError(400, "BAD_REQUEST", "body is not valid JSON", { cause: err }));
      }
    },
  );

  // Every error leaves as { error: { code, message } }.
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      // Server-side failures keep a record of the underlying cause for diagnosis.
      if (error.statusCode >= 500) app.log.error({ err: error }, error.code);
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      return reply.status(error.statusCode).send(body);
    }
    if (error.validation) {
      const body: ErrorBody = { error: { code: "BAD_REQUEST", message: error.message } };
      return reply.status(400).send(body);
    }
    // Unexpected: log it, and never leak internals in production.
    app.log.error(error);
    const message = deps.config.NODE_ENV === "production" ? "Internal Server Error" : error.message;
    const body: ErrorBody = { error: { code: "INTERNAL", message } };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` },
    };
    return reply.status(404).send(body);
  });

  // CORS before anything routed: its hook runs on `onRequest`, so a preflight is
  // answered ahead of every route's auth preHandler.
  registerCors(app, deps.config.CORS_ALLOWED_ORIGINS);

  // Auth seam: exposes `app.authenticate` for routes to guard with. Registered
  // app-wide here; /health stays public (no preHandler).
  registerAuth(app, deps.auth);
  registerHealthRoute(app, { db: deps.db });
  registerCategoriesRoute(app, { categories: deps.repos.categories });
  registerFixedExpensesRoutes(app, {
    expenses: deps.repos.expenses,
    categories: deps.repos.categories,
  });
  registerTransactionsRoutes(app, {
    transactions: deps.repos.transactions,
    categories: deps.repos.categories,
  });
  registerStatsRoute(app, {
    transactions: deps.repos.transactions,
    expenses: deps.repos.expenses,
    profiles: deps.repos.profiles,
  });
  // One budget spanning both refresh routes, deliberately: they draw on the same
  // paid model, so a per-route limit would let a caller alternate between them
  // and spend twice the intended ceiling.
  const refreshLimiter = createRateLimiter({
    limit: deps.config.REFRESH_RATE_LIMIT,
    windowMs: deps.config.REFRESH_RATE_LIMIT_WINDOW_SEC * 1000,
  });
  const refreshRateLimit = rateLimitByUser(refreshLimiter, "refresh");

  registerProfileRoutes(app, {
    llm: deps.llm,
    transactions: deps.repos.transactions,
    expenses: deps.repos.expenses,
    profiles: deps.repos.profiles,
    summaries: deps.repos.summaries,
    categories: deps.repos.categories,
    refreshRateLimit,
  });
  registerSuggestionsRoutes(app, {
    llm: deps.llm,
    transactions: deps.repos.transactions,
    expenses: deps.repos.expenses,
    profiles: deps.repos.profiles,
    summaries: deps.repos.summaries,
    suggestions: deps.repos.suggestions,
    agentRuns: deps.repos.agentRuns,
    categories: deps.repos.categories,
    logger: app.log,
    refreshRateLimit,
  });

  return app;
}
