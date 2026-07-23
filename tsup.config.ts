import { defineConfig } from "tsup";

// Production build: bundle the server entrypoint to ESM under dist/. Only our own
// source is inlined — every dependency (the Prisma client, Fastify, the Anthropic
// SDK) stays external and is resolved from node_modules at runtime, so the generated
// Prisma query engine is never dragged through the bundler. Inlining our own
// relative imports is also what lets the extensionless, "Bundler"-resolution source
// run under Node's ESM loader without rewriting every import to carry a `.js`.
export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
});
