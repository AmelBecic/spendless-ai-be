// Cross-origin access for the browser client (SLAI-23). One allow-list, read
// from config, drives every CORS header the API emits.

import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

/**
 * How long a browser may cache a preflight result. A day is the practical
 * ceiling — Chrome caps it at 2h regardless — and spares the client an extra
 * round trip before each authenticated request.
 */
const PREFLIGHT_MAX_AGE_SEC = 86_400;

/**
 * The methods a preflight is told the API accepts.
 *
 * Hand-maintained but not free to drift: `cors.test.ts` walks the real route
 * table and fails if anything routed is missing here — a method absent from this
 * list makes the browser block the request with nothing failing server-side.
 * `HEAD` earns its place because Fastify registers one for every `GET`, and no
 * `PUT` appears because updates in this API are `PATCH`.
 */
export const CORS_ALLOWED_METHODS = ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"];

/**
 * Register CORS against an exact-match allow-list.
 *
 * `origin` is a function rather than the array form on purpose. Given an array,
 * the plugin omits `Access-Control-Allow-Origin` for an unknown origin but still
 * writes the static headers (`Allow-Credentials`, and on a preflight
 * `Allow-Methods` / `Allow-Headers` / `Max-Age`) — see fastify/fastify-cors#127.
 * Resolving to `false` instead makes the plugin a no-op for that request, so a
 * rejected origin gets no CORS headers at all and learns nothing about the
 * methods or headers the API accepts.
 *
 * Registered app-wide via a hook that runs on `onRequest`, which is why a
 * preflight is answered before any route's `authenticate` preHandler: an
 * `OPTIONS` carries no `Authorization` header, so a preflight behind auth would
 * 401 and the real request would never be sent.
 */
export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);

  void app.register(cors, {
    origin: (origin, cb) => {
      // No `Origin` header — a same-origin request or a non-browser client
      // (curl, the scheduler, a health probe). There is nothing to grant.
      if (origin === undefined) return cb(null, false);
      cb(null, allowed.has(origin) ? origin : false);
    },
    // Exact origins only (enforced by the env schema), so credentialed requests
    // are safe to allow: this is what lets the client send its Supabase session.
    credentials: true,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: ["Authorization", "Content-Type"],
    // The rate-limit headers on the refresh routes are useless to the client if
    // the browser hides them.
    exposedHeaders: ["Retry-After"],
    maxAge: PREFLIGHT_MAX_AGE_SEC,
  });
}
