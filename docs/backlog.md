# SpendLess AI — Backend Backlog

Project key: **SLAI** · Board 67 · Repo scope: label **`backend`** · Jira `becicamel98.atlassian.net`
(team-managed project — repos are scoped by label, not component)

Each ticket = one feature branch → PR → ai-code-reviewer → merge, driven by the `/ticket` skill.
**Acceptance criteria are written so the reviewer can check requirement fulfilment against them.**

**What this backend is.** A production, multi-tenant API for a *grounded personal-finance profiling
agent* — not a budget-tracker CRUD and not a chatbot. Users log fixed monthly expenses + daily
spending; an incremental day-by-day summarization loop maintains an evolving per-user profile; the
agent emits **cited** savings suggestions; an eval harness measures quality. Numbers are always
computed in code — **the LLM interprets, it never does arithmetic.**

**Stack:** Node/TS (ESM) · **Fastify** · **Prisma** migrations over **Supabase Postgres** ·
**Supabase Auth** (JWT verified in-process, every query scoped by `userId`) · `claude-opus-4-8`
(structured output + prompt caching, `ANTHROPIC_API_KEY` server-side). Dockerized for deploy.

**Money rule:** integer `amountCents` + `currency` everywhere. No floats, no cross-currency
arithmetic. (Same trap Trip Planner's `Money` type killed.)

---

# Sprint 1 — Backend foundation (DB · auth · CRUD · stats)

Epic: **[SLAI-1]**. Goal: a running, tested, multi-tenant API that persists expenses and
transactions and computes deterministic spend stats — the substrate the agent (Sprint 2) sits on.
No LLM in this sprint.

## Foundation

### SLAI-2 · Fastify bootstrap, config & health
**Type:** Task · **Labels:** backend, foundation
Server entrypoint, typed env loading, health check, and a consistent error/response envelope.
**Acceptance criteria:**
- `src/app.ts` builds a Fastify instance (plugins, logger) separately from `src/server.ts` which
  listens — so tests can import the app without binding a port.
- Env parsed and validated **once** at boot via a typed schema (zod); missing/invalid env fails fast
  with a clear message. Documented in `.env.example` (`DATABASE_URL`, `SUPABASE_*`, `PORT`).
- `GET /health` returns `{ status: "ok" }` and a DB connectivity check.
- A single error handler maps thrown errors to a typed JSON envelope `{ error: { code, message } }`;
  no raw stack traces leak in production mode.
- `npm run typecheck` and `npm run lint` pass; no `any` in the added code.

### SLAI-3 · Domain types & Money helpers
**Type:** Task · **Labels:** backend, foundation, types
The shared vocabulary the whole API and (later) the clients speak.
**Acceptance criteria:**
- `src/domain/types.ts` defines `Money` (`amountCents: number`, `currency: string`),
  `Category`, `FixedExpense`, `Transaction`, `Cadence`, `SpendStats`, `ProfileSummary`, `Suggestion`.
- `src/domain/money.ts` provides `add`, `sum`, and `format` that **throw on mixed currencies** and
  operate only on integer cents.
- Pure, unit-tested (including the mixed-currency throw); no `any`, no floats.

### SLAI-4 · Prisma schema, initial migration & category seed
**Type:** Task · **Labels:** backend, foundation, db · **Depends on:** SLAI-3
The persistence contract. Owns the schema so the DB is portable off Supabase later.
**Acceptance criteria:**
- `prisma/schema.prisma` models `UserProfile`, `Category`, `FixedExpense`, `Transaction`,
  `ProfileSummary`, `Suggestion` matching `src/domain/types.ts`. Money as `Int` cents + `String`
  currency; no `Float` on any money column.
- Every user-owned row has `userId` (uuid) with an index; composite indexes `(userId, occurredAt)`
  on transactions and `(userId, asOfDate)` on summaries/suggestions.
- `prisma migrate dev` produces a checked-in migration that applies cleanly to an empty database.
- A seed (`prisma/seed.ts`) inserts the fixed category set (groceries, dining, transport, rent,
  utilities, subscriptions, entertainment, health, other) idempotently.
- No secrets committed; `DATABASE_URL` read from env only.

### SLAI-5 · Prisma client & test-database harness
**Type:** Task · **Labels:** backend, foundation, db · **Depends on:** SLAI-4
One shared client; integration tests run against a real disposable Postgres, not mocks.
**Acceptance criteria:**
- `src/db/client.ts` exports a singleton `PrismaClient` (no client-per-request leak).
- A test harness spins up/migrates a disposable Postgres (Testcontainers or a documented local test
  DB) and truncates between tests; `npm run test` needs no production credentials.
- CI runs the integration tests against that ephemeral DB.

### SLAI-6 · Supabase Auth JWT verification middleware
**Type:** Task · **Labels:** backend, foundation, auth · **Depends on:** SLAI-2
The multi-tenant boundary. Behind an interface so the auth provider can be swapped.
**Acceptance criteria:**
- A Fastify preHandler verifies the incoming Supabase JWT (signature + exp + audience) and sets
  `req.user = { id }`; verification lives behind an `AuthVerifier` interface, not inlined.
- Missing/invalid/expired token → `401` with the standard error envelope; a valid token populates
  `req.user.id` (the Supabase `auth.users.id`).
- On first authenticated request, a `UserProfile` row is provisioned if absent (default currency +
  timezone), idempotently.
- Unit-tested with signed test tokens (a test signing key), no live Supabase call in tests.

### SLAI-7 · Per-user repository layer (isolation seam)
**Type:** Task · **Labels:** backend, foundation · **Depends on:** SLAI-5, SLAI-6
Every data access goes through repositories that **cannot** return another user's rows.
**Acceptance criteria:**
- `src/repositories/` exposes `expenses`, `transactions`, `profiles`, `suggestions` repos; **every**
  read/write takes `userId` and filters/sets it — no repository method can omit the user scope.
- Route handlers use repositories only; no handler builds a Prisma query directly.
- An integration test proves user A cannot read, update, or delete user B's rows (returns empty / 404,
  never B's data).

## CRUD & stats

### SLAI-8 · Categories endpoint
**Type:** Task · **Labels:** backend, api · **Depends on:** SLAI-4
**Acceptance criteria:**
- `GET /categories` returns the seeded categories (typed, stable ordering).
- Requires a valid JWT; unauthenticated → 401.

### SLAI-9 · Fixed expenses CRUD
**Type:** Story · **Labels:** backend, api · **Depends on:** SLAI-7
Recurring monthly/weekly/yearly commitments (rent, subscriptions…).
**Acceptance criteria:**
- `POST/GET/PATCH/DELETE /fixed-expenses` create, list, update, soft-deactivate a fixed expense.
- Body validated (label, categoryId exists, amountCents > 0, currency, cadence ∈ enum); invalid → 400
  with field-level errors, never reaching the DB.
- All operations scoped to `req.user.id`; listing returns only the caller's expenses.
- Integration-tested incl. the validation and cross-user isolation paths.

### SLAI-10 · Transactions CRUD (daily spend)
**Type:** Story · **Labels:** backend, api · **Depends on:** SLAI-7
The primary event stream the profile is built from.
**Acceptance criteria:**
- `POST/GET/PATCH/DELETE /transactions`; create takes amountCents, currency, categoryId, merchant?,
  note?, occurredAt (defaults to now).
- `GET` supports pagination (cursor or limit/offset) and `from`/`to` date filtering; ordering is
  deterministic (occurredAt desc, id tiebreak).
- Validation as SLAI-9; all scoped to the caller; cross-user isolation tested.
- Amounts are integer cents on the wire and in storage — a float amount is rejected.

### SLAI-11 · Deterministic aggregation service + `GET /stats`
**Type:** Story · **Labels:** backend, agent, stats · **Depends on:** SLAI-10, SLAI-9
The arithmetic layer the LLM will later read but never perform. **Contains no LLM call.**
**Acceptance criteria:**
- `src/agent/aggregate.ts` (pure functions) computes, for a user over a period: total spend,
  per-category totals + shares, top categories, recurring-vs-discretionary split (fixed expenses vs
  transactions), daily/weekly averages, and month-over-month delta.
- Reads only through the repository layer; deterministic — same inputs, same output; no network.
- `GET /stats?from=&to=` returns the typed `SpendStats`; amounts respect the Money rules (no
  cross-currency sums — mixed currencies surface an explicit typed error, not a wrong number).
- Unit-tested against fixture ledgers with hand-computed expected totals, incl. the empty-ledger and
  single-currency-guard cases.

### SLAI-12 · CI, secrets & repo hygiene
**Type:** Chore · **Labels:** backend, ci
**Acceptance criteria:**
- `.github/workflows/ci.yml` runs lint · typecheck · test (against the ephemeral DB) and a PR-title
  check requiring the `SLAI-` prefix; `npm run secrets` (gitleaks) passes.
- `.env.example` documents every key with no real values; no secret is committed.
- `README.md` replaced with a real project intro (what it is, the architecture, how to run locally).

---

# Sprint 2 — The profiling agent (rolling summary · suggestions · evals)

Epic: **[SLAI-13]**. This is what the app is *for*. Builds the incremental profile loop and the
grounded suggestion engine on top of Sprint 1's deterministic stats, then measures quality.

Headline tickets (AC to be expanded when the sprint starts, Trip-Planner style):
- **Anthropic client** — `agent/anthropic.ts`: `claude-opus-4-8`, structured output via
  `output_config.format`, prompt caching on the stable system prompt + tool defs, key server-side.
  *(Confirm exact params against the `claude-api` skill first.)*
- **Profiling agent (incremental)** — previous `ProfileSummary` + new transactions since last run +
  fresh `SpendStats` → updated structured summary + narrative. Never reprocesses full history.
  `POST /profile/refresh`, `GET /profile`.
- **Suggestion agent (grounded + cited)** — latest summary + stats → suggestions, each citing the
  stat/category it rests on; `estMonthlySavingsCents` computed in code. `GET /suggestions`,
  `PATCH /suggestions/:id` (dismiss/apply). No hallucinated figures.
- **Daily refresh job + cost guardrails** — scheduled per-user refresh that skips when there's no new
  activity; per-user rate limit on LLM routes; caching. Deployed app spends real money per call.
- **Eval harness (`evals/`)** — synthetic users with known-correct answers; scores grounding /
  correctness / actionability / safety / graceful-degradation; `npm run eval` prints per-case +
  aggregate and exits non-zero on regression. Seed numbers + metric definitions written to README.

---

# Later sprints (out of scope for now, tracked so the shape is clear)
- **Sprint 3 — Web client** (`spendless-ai-web`, Next.js, component `frontend`): login, log expense /
  daily spend, dashboard (stats + profile narrative), suggestions feed.
- **Sprint 4 — Deploy + writeup**: Docker → Fly/Railway/Render + managed Postgres, live URLs, README
  with eval numbers and the "API key vs subscription CLI" tradeoff; flip public as an outreach hook.
- **Later — Mobile** (Expo) on the same API.
