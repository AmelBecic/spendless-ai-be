// The one shared Prisma client for the whole app. A client-per-request would
// exhaust the connection pool; the global cache also survives dev hot-reloads.
// (The /health liveness ping keeps its own lightweight pg check in db/pool.ts;
// application data access goes through this client.)

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
