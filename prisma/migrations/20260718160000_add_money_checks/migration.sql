-- Database-level guards on money/currency, as defence-in-depth beneath the
-- application validation. These CHECK constraints aren't expressible in
-- schema.prisma, so they live here as raw SQL. All money tables are empty at
-- this point, so the constraints apply cleanly.

-- Currency is always a 3-letter ISO-4217 code.
ALTER TABLE "user_profiles"  ADD CONSTRAINT "user_profiles_currency_len"   CHECK (char_length("currency") = 3);
ALTER TABLE "fixed_expenses" ADD CONSTRAINT "fixed_expenses_currency_len"  CHECK (char_length("currency") = 3);
ALTER TABLE "transactions"   ADD CONSTRAINT "transactions_currency_len"    CHECK (char_length("currency") = 3);
ALTER TABLE "suggestions"    ADD CONSTRAINT "suggestions_currency_len"     CHECK (char_length("currency") = 3);

-- Amounts: expenses/transactions are strictly positive; savings and income are
-- non-negative (income is nullable).
ALTER TABLE "fixed_expenses" ADD CONSTRAINT "fixed_expenses_amount_pos"    CHECK ("amountCents" > 0);
ALTER TABLE "transactions"   ADD CONSTRAINT "transactions_amount_pos"      CHECK ("amountCents" > 0);
ALTER TABLE "suggestions"    ADD CONSTRAINT "suggestions_savings_nonneg"   CHECK ("estMonthlySavingsCents" >= 0);
ALTER TABLE "user_profiles"  ADD CONSTRAINT "user_profiles_income_nonneg"  CHECK ("monthlyIncomeCents" IS NULL OR "monthlyIncomeCents" >= 0);
