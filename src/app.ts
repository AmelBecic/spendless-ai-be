// Builds the Fastify app with its error/response contract wired in. Kept separate
// from server.ts (which listens) so tests can drive it via `inject` — no port,
// no real database — by passing stub deps.

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Env } from "./config/env";
import { AppError, type ErrorBody } from "./http/errors";
import { registerHealthRoute } from "./routes/health";

export interface AppDeps {
  config: Env;
  db: { ping: () => Promise<void> };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.config.NODE_ENV !== "test" });

  // Every error leaves as { error: { code, message } }.
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      // Server-side failures keep a record of the underlying cause for diagnosis.
      if (error.statusCode >= 500) app.log.error({ err: error }, error.code);
      const body: ErrorBody = { error: { code: error.code, message: error.message } };
      return reply.status(error.statusCode).send(body);
    }
    if (error.validation) {
      const body: ErrorBody = { error: { code: "BAD_REQUEST", message: error.message } };
      return reply.status(400).send(body);
    }
    // Unexpected: log it, and never leak internals in production.
    app.log.error(error);
    const message =
      deps.config.NODE_ENV === "production" ? "Internal Server Error" : error.message;
    const body: ErrorBody = { error: { code: "INTERNAL", message } };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` },
    };
    return reply.status(404).send(body);
  });

  registerHealthRoute(app, { db: deps.db });

  return app;
}
