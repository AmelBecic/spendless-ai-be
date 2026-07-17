import type { FastifyInstance } from "fastify";
import { AppError } from "../http/errors";

export interface HealthDeps {
  db: { ping: () => Promise<void> };
}

/** GET /health — 200 { status: "ok" } only if the database is reachable. */
export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/health", async () => {
    try {
      await deps.db.ping();
    } catch {
      throw new AppError(503, "DB_UNAVAILABLE", "database is not reachable");
    }
    return { status: "ok" };
  });
}
