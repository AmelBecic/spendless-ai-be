-- Cost guardrails for the daily refresh job (SLAI-19).

-- Which agent a recorded pass belongs to.
CREATE TYPE "AgentRunKind" AS ENUM ('profile', 'suggestions');

-- Records THAT a pass ran for a user on a day, independently of its output, so
-- the day-guard stops keying on rows the pass may legitimately not have written.
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "AgentRunKind" NOT NULL,
    "asOfDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- One pass per user per kind per day. Also what makes a racing second pass a
-- constraint violation rather than a duplicate (paid) completion.
CREATE UNIQUE INDEX "agent_runs_userId_kind_asOfDate_key"
    ON "agent_runs" ("userId", "kind", "asOfDate");

ALTER TABLE "agent_runs"
    ADD CONSTRAINT "agent_runs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user_profiles" ("userId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The scheduler's per-user activity probe filters on createdAt, which the
-- (userId, occurredAt) index cannot serve.
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions" ("userId", "createdAt");

-- Defence-in-depth, matching every other table: the backend connects as the
-- table owner and so bypasses RLS, but Supabase's anon/PostgREST role must not
-- reach per-user data with the public publishable key. No policies = deny all.
-- (Owner and BYPASSRLS roles such as service_role are unaffected.)
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
