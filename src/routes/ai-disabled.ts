import type { FastifyInstance } from "fastify";
import { AppError } from "../http/errors";

// No-AI mode. When the server has no ANTHROPIC_API_KEY the profiling + suggestion
// features can't run, but their routes still answer — with a typed AI_DISABLED (503)
// rather than a bare 404 — so the web client can tell "feature is off" apart from
// "wrong URL" and degrade gracefully instead of surfacing a generic error.
//
// The paths here mirror registerProfileRoutes / registerSuggestionsRoutes exactly;
// only one of the two registrars runs for a given boot (see buildApp). No auth
// preHandler: the capability is off for everyone, so there is nothing to scope.
export function registerAiDisabledRoutes(app: FastifyInstance): void {
  const unavailable = async (): Promise<never> => {
    throw new AppError(
      503,
      "AI_DISABLED",
      "AI features are disabled: no model API key is configured",
    );
  };

  app.get("/profile", unavailable);
  app.post("/profile/refresh", unavailable);
  app.get("/suggestions", unavailable);
  app.post("/suggestions/refresh", unavailable);
  app.patch("/suggestions/:id", unavailable);
}
