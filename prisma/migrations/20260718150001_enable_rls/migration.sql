-- Row-level security as defence-in-depth.
--
-- Access is exclusively through the Fastify backend, which connects as the table
-- owner and therefore bypasses RLS. Enabling RLS with NO policies denies
-- Supabase's PostgREST / anon + authenticated roles by default, so the public
-- publishable key cannot read or write per-user financial data directly.

ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fixed_expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "profile_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suggestions" ENABLE ROW LEVEL SECURITY;
