// The canonical spend-category set — the source of truth seeded into the DB
// (prisma/seed.ts) and shared wherever category keys are referenced.

export interface CategorySeed {
  key: string;
  label: string;
}

export const CATEGORIES = [
  { key: "groceries", label: "Groceries" },
  { key: "dining", label: "Dining" },
  { key: "transport", label: "Transport" },
  { key: "rent", label: "Rent" },
  { key: "utilities", label: "Utilities" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "entertainment", label: "Entertainment" },
  { key: "health", label: "Health" },
  { key: "other", label: "Other" },
] as const satisfies readonly CategorySeed[];

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
