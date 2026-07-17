// Process entrypoint: load env, open the DB pool, build the app, listen, and
// shut down cleanly. All the wiring the app itself stays ignorant of.

import "dotenv/config";
import { loadEnv } from "./config/env";
import { createPool, pingPool } from "./db/pool";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const config = loadEnv();
  const pool = createPool(config);
  const app = buildApp({ config, db: { ping: () => pingPool(pool) } });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    await pool.end();
    process.exit(1);
  }
}

void main();
