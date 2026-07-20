// GET /profile — the caller's latest AI-maintained profile summary.
// POST /profile/refresh — recompute the stats, run the profiling agent, persist.
//
// Both are scoped to `req.user.id` and never read a user id from the request, so
// there is no parameter a caller could set to reach someone else's profile.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ProfileSummary } from "../domain/types";
import { MixedCurrencyError } from "../domain/money";
import { LedgerTooLargeError } from "../agent/stats";
import { refreshProfile, type ProfileRefreshDeps } from "../agent/profile-refresh";
import type { ProfileSummariesRepository } from "../repositories/profile-summaries";
import { requireUser } from "../auth/plugin";
import { AppError } from "../http/errors";

export type ProfileDeps = ProfileRefreshDeps & {
  summaries: ProfileSummariesRepository;
  /** Meters the paid refresh route per user. GET /profile is free and unmetered. */
  refreshRateLimit: preHandlerHookHandler;
};

export interface ProfileResponse {
  profile: ProfileSummary;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDeps): void {
  app.get("/profile", { preHandler: app.authenticate }, async (req): Promise<ProfileResponse> => {
    const user = requireUser(req);
    const profile = await deps.summaries.latest(user.id);
    // A profile that has never been refreshed has no summary to return. An empty
    // one would be indistinguishable from a real summary that found nothing to
    // say, so the absence is reported as an absence.
    if (!profile) {
      throw new AppError(404, "NOT_FOUND", "no profile summary yet — refresh to build one");
    }
    return { profile };
  });

  app.post(
    "/profile/refresh",
    // Order matters: authenticate first, so the limiter has a user to key on.
    { preHandler: [app.authenticate, deps.refreshRateLimit] },
    async (req, reply): Promise<ProfileResponse> => {
      const user = requireUser(req);

      try {
        const profile = await refreshProfile(deps, user.id, new Date());
        // 200, not 201: the summary is upserted per day, so a second refresh
        // rewrites today's row rather than creating a second resource.
        reply.status(200);
        return { profile };
      } catch (err) {
        if (err instanceof MixedCurrencyError) {
          // Same reasoning as GET /stats: the request is well-formed, the stored
          // ledger is not, and no total over it would carry an honest label.
          throw new AppError(409, "MIXED_CURRENCY", err.message, { cause: err });
        }
        if (err instanceof LedgerTooLargeError) {
          throw new AppError(422, "PERIOD_TOO_LARGE", err.message, { cause: err });
        }
        throw err;
      }
    },
  );
}
