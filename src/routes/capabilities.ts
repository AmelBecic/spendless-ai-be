import type { FastifyInstance } from "fastify";

export interface CapabilitiesDeps {
  /** Whether the server was started with a model API key. */
  ai: boolean;
}

/** What the client is told the server can do. Kept deliberately small — one flag
 *  per optional capability, no version or build detail a client shouldn't branch on. */
export interface CapabilitiesResponse {
  ai: boolean;
}

/** GET /capabilities — advertises which optional features this server supports.
 *  Public (no auth), like /health: the web client reads it before offering AI mode,
 *  and a client with no session still needs the answer to render the right UI. */
export function registerCapabilitiesRoute(app: FastifyInstance, deps: CapabilitiesDeps): void {
  app.get("/capabilities", async (): Promise<CapabilitiesResponse> => ({ ai: deps.ai }));
}
