// Postgres connection pool + a lightweight liveness ping used by /health.
// Schema and queries arrive with Prisma in SLAI-4; this is just the raw
// connection so the app can report DB reachability from day one.

import { Pool } from "pg";
import type { Env } from "../config/env";

export function createPool(config: Env): Pool {
  return new Pool({ connectionString: config.DATABASE_URL, max: 10 });
}

/** Round-trips a trivial query. Rejects if the database is unreachable. */
export async function pingPool(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}
