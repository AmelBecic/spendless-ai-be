// The auth middleware: a Fastify preHandler that turns a bearer token into
// `req.user`. Routes opt in with `{ preHandler: app.authenticate }`; anything
// unauthenticated leaves as the standard 401 envelope via the app error handler.

import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { AppError } from "../http/errors";
import type { AuthVerifier, AuthenticatedUser } from "./verifier";
import type { ProfileStore } from "./profile-store";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated user, populated by the `authenticate` preHandler. */
    user?: AuthenticatedUser;
  }
  interface FastifyInstance {
    /** preHandler that authenticates the request or throws a 401. */
    authenticate: preHandlerHookHandler;
  }
}

export interface AuthDeps {
  verifier: AuthVerifier;
  profiles: ProfileStore;
}

const BEARER = /^Bearer (.+)$/;

/** Extract the bearer token from the Authorization header, or throw a 401. */
function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  const token = header ? BEARER.exec(header)?.[1] : undefined;
  if (!token) {
    throw new AppError(401, "UNAUTHORIZED", "missing or malformed Authorization header");
  }
  return token;
}

/**
 * Narrow `req.user` for a handler that runs behind `authenticate`.
 *
 * The preHandler always sets it, but the field is optional app-wide (public
 * routes like /health never have one), so scoped handlers come through here
 * instead of asserting non-null. If the guard were ever dropped from a route,
 * this fails closed with a 401 rather than handing the repository `undefined`
 * as a userId.
 */
export function requireUser(req: FastifyRequest): AuthenticatedUser {
  if (!req.user) {
    throw new AppError(401, "UNAUTHORIZED", "request is not authenticated");
  }
  return req.user;
}

/**
 * Register the auth seam. Decorates the app with `authenticate`, a preHandler
 * that verifies the bearer token, provisions the caller's profile on first
 * sight (idempotent thereafter), and sets `req.user`.
 */
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const authenticate: preHandlerHookHandler = async (req) => {
    const token = bearerToken(req);
    const user = await deps.verifier.verify(token);
    await deps.profiles.ensureProfile(user.id);
    req.user = user;
  };
  app.decorate("authenticate", authenticate);
}
