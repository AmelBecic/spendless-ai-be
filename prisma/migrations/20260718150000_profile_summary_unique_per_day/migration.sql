-- DropIndex
DROP INDEX "profile_summaries_userId_asOfDate_idx";

-- CreateIndex
CREATE UNIQUE INDEX "profile_summaries_userId_asOfDate_key" ON "profile_summaries"("userId", "asOfDate");
