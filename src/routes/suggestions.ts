// /suggestions — the caller's grounded savings suggestions.
//
// GET lists them, PATCH flips one's status, POST /suggestions/refresh runs the
// agent to produce today's set. Same scoping contract as every other resource
// route: the caller is resolved through `requireUser` and that id goes to the
// repository, so there is no parameter a client could set to reach another
// user's row — a foreign id is a 404, indistinguishable from a missing one.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Suggestion } from "../domain/types";
import { MixedCurrencyError } from "../domain/money";
import { LedgerTooLargeError } from "../agent/stats";
import { refreshSuggestions, type SuggestRefreshDeps } from "../agent/suggest-refresh";
import type { SuggestionsRepository } from "../repositories/suggestions";
import { MAX_PAGE_SIZE } from "../repositories/shared";
import { requireUser } from "../auth/plugin";
import { AppError } from "../http/errors";
import { parseOrThrow } from "../http/validation";
import { isoDate } from "./fields";

export type SuggestionsDeps = SuggestRefreshDeps & {
  suggestions: SuggestionsRepository;
  /** Meters the paid refresh route per user. GET and PATCH are free and unmetered. */
  refreshRateLimit: preHandlerHookHandler;
};

/** The single-suggestion response body (PATCH). */
export interface SuggestionResponse {
  suggestion: Suggestion;
}

/** The GET /suggestions response body — one page plus the cursor for the next. */
export interface SuggestionsResponse {
  suggestions: Suggestion[];
  /** `null` once the listing is exhausted. */
  nextCursor: string | null;
}

const ListQuery = z
  .object({
    // A whole UTC day: suggestions are produced per `asOfDate`, so filtering to
    // an instant would match nothing.
    asOfDate: isoDate.optional(),
    status: z.enum(["new", "dismissed", "applied"]).optional(),
    limit: z.coerce
      .number()
      .int("must be a whole number")
      .positive("must be greater than 0")
      .max(MAX_PAGE_SIZE, `must be at most ${MAX_PAGE_SIZE}`)
      .optional(),
    cursor: z.guid("must be a suggestion id").optional(),
  })
  .strict();

const IdParams = z.object({ id: z.guid("must be a suggestion id") }).strict();

// `new` is deliberately not settable: it is the state the agent writes, and
// letting a client rewind a decision would make "dismissed" mean nothing.
const UpdateBody = z.object({ status: z.enum(["dismissed", "applied"]) }).strict();

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "suggestion not found");
}

export function registerSuggestionsRoutes(app: FastifyInstance, deps: SuggestionsDeps): void {
  const guard = { preHandler: app.authenticate };

  app.get("/suggestions", guard, async (req): Promise<SuggestionsResponse> => {
    const user = requireUser(req);
    const query = parseOrThrow(ListQuery, req.query, "invalid query parameters");

    const { asOfDate, ...rest } = query;
    const page = await deps.suggestions.list(user.id, {
      ...rest,
      // The repository filters on a `date` column, so the day has to arrive as
      // the UTC midnight that column stores.
      ...(asOfDate ? { asOfDate: new Date(`${asOfDate}T00:00:00.000Z`) } : {}),
    });
    return { suggestions: page.items, nextCursor: page.nextCursor };
  });

  app.patch("/suggestions/:id", guard, async (req): Promise<SuggestionResponse> => {
    const user = requireUser(req);
    const { id } = parseOrThrow(IdParams, req.params, "invalid suggestion id");
    const { status } = parseOrThrow(UpdateBody, req.body, "invalid suggestion");

    const suggestion = await deps.suggestions.setStatus(user.id, id, status);
    if (!suggestion) throw notFound();
    return { suggestion };
  });

  // Order matters: authenticate first, so the limiter has a user to key on.
  const meteredGuard = { preHandler: [app.authenticate, deps.refreshRateLimit] };

  app.post(
    "/suggestions/refresh",
    meteredGuard,
    async (req, reply): Promise<SuggestionsResponse> => {
      const user = requireUser(req);

      try {
        const suggestions = await refreshSuggestions(deps, user.id, new Date());
        // 200, not 201: the set is per-day, so a second refresh returns the rows
        // that already exist rather than creating more.
        reply.status(200);
        return { suggestions, nextCursor: null };
      } catch (err) {
        if (err instanceof MixedCurrencyError) {
          // Same reasoning as GET /stats: the request is well-formed, the stored
          // ledger is not, and no saving computed over it would carry an honest
          // label.
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
