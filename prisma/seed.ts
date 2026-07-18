// Seeds the fixed category set. Idempotent — safe to run repeatedly.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CATEGORIES: ReadonlyArray<readonly [key: string, label: string]> = [
  ["groceries", "Groceries"],
  ["dining", "Dining"],
  ["transport", "Transport"],
  ["rent", "Rent"],
  ["utilities", "Utilities"],
  ["subscriptions", "Subscriptions"],
  ["entertainment", "Entertainment"],
  ["health", "Health"],
  ["other", "Other"],
];

async function main(): Promise<void> {
  for (const [key, label] of CATEGORIES) {
    await prisma.category.upsert({ where: { key }, update: { label }, create: { key, label } });
  }
  console.log(`Seeded ${CATEGORIES.length} categories`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
