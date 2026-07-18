-- CreateIndex
CREATE INDEX "fixed_expenses_categoryId_idx" ON "fixed_expenses"("categoryId");

-- CreateIndex
CREATE INDEX "suggestions_categoryId_idx" ON "suggestions"("categoryId");

-- CreateIndex
CREATE INDEX "transactions_categoryId_idx" ON "transactions"("categoryId");
