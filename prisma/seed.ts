// Seeds the fixed category set. Idempotent — safe to run repeatedly.
// The category set itself lives in src/domain/categories.ts (typed + unit-tested).

import { PrismaClient } from "@prisma/client";
import { CATEGORIES } from "../src/domain/categories";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  for (const { key, label } of CATEGORIES) {
    await prisma.category.upsert({ where: { key }, update: { label }, create: { key, label } });
  }
  console.log(`Seeded ${CATEGORIES.length} categories`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
