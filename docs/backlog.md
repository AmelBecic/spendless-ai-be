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

Epic: **[SLAI-15]**. This is what the app is *for*. Builds the incremental profile loop and the
grounded suggestion engine on top of Sprint 1's deterministic stats, then measures quality.
(The old backlog draft numbered this epic SLAI-13 — that key was taken by a Sprint-1 chore; the
Sprint 2 epic is **SLAI-15** and the tickets below are **SLAI-16 → 20**, created with full AC in Jira.)

Tickets (dependency order — full AC lives on the Jira issues):
- **SLAI-16 · Anthropic client seam** — `agent/anthropic.ts`: `claude-opus-4-8`, structured output via
  `output_config.format` (`messages.parse`), prompt caching on the stable system prompt + tool defs,
  adaptive thinking, key server-side. **No `temperature`/`top_p`/`top_k`** (they 400 on Opus 4.8);
  `ANTHROPIC_API_KEY` added to `.env.example` + the env schema in the same commit (parity test).
  Confirmed against the `claude-api` skill.
- **SLAI-17 · Profiling agent (incremental)** — previous `ProfileSummary` + new transactions since last
  run + fresh `SpendStats` → updated structured summary + narrative. Never reprocesses full history.
  `POST /profile/refresh`, `GET /profile`. *(depends on SLAI-16)*
- **SLAI-18 · Suggestion agent (grounded + cited)** — latest summary + stats → suggestions, each citing
  the stat/category it rests on; `estMonthlySavingsCents` computed in code. `GET /suggestions`,
  `PATCH /suggestions/:id` (dismiss/apply). No hallucinated figures. *(depends on SLAI-17)*
- **SLAI-19 · Daily refresh job + cost guardrails** — scheduled per-user refresh that skips when there's
  no new activity; per-user rate limit on LLM routes; caching. Deployed app spends real money per call.
  *(depends on SLAI-17, SLAI-18)*
- **SLAI-20 · Eval harness (`evals/`)** — synthetic users with known-correct answers; scores grounding /
  correctness / actionability / safety / graceful-degradation; `npm run eval` prints per-case +
  aggregate and exits non-zero on regression. Seed numbers + metric definitions written to README.
  **Land this first within the 19/20 pair — the eval numbers are the portfolio differentiator.**
  *(depends on SLAI-17, SLAI-18)*

---

# Sprint 3 — Web client (`spendless-ai-web`)

Epic: **[SLAI-22]**, tickets **SLAI-23 → 28**, created with full AC in Jira. Goal: a Next.js client that logs spend, shows the
profile, and — the point of the whole project — renders each suggestion **next to the stat it rests
on**. Two repos: the CORS ticket lands in this one, the rest in `spendless-ai-web` (label `frontend`).

**Standing caveat.** Every agent path is stub-proven only — no `ANTHROPIC_API_KEY` has ever been
used against the live API, so the structured-output and prompt-caching contracts are unverified.
The web repo's README must say so; a demo that breaks will break there first.

**Type sharing: hand-copied, deliberately.** The web repo does *not* install the backend as a
dependency — the backend's `postinstall` runs `prisma generate`, which would pull Prisma and the
whole backend dep tree into a frontend install. The accepted cost is silent drift, mitigated by
keeping every copied type in one file with the source SHA recorded (SLAI-24).

## Backend prerequisite

### SLAI-23 · CORS for the web client
**Type:** Task · **Labels:** backend, api
No CORS exists anywhere in the API today, so a browser client fails preflight on every request.
Blocks the whole sprint.
**Acceptance criteria:**
- `@fastify/cors` registered in `src/app.ts`; allowed origins read from the typed env schema (not
  hardcoded), documented in `.env.example` in the **same commit** so the parity test stays green.
- A single origin list drives it; `*` is not used when credentials are enabled.
- Preflight (`OPTIONS`) on an authenticated route returns the right `Access-Control-Allow-*` headers
  without invoking the auth preHandler.
- Rejected origins get no CORS headers — asserted in a test, both accepted and rejected paths.
- Gates green; no `any`.

## Web client

### SLAI-24 · Repo scaffold, house rules & the copied contract
**Type:** Task · **Labels:** frontend, foundation
The workflow discipline is half of what this project demonstrates — a frontend repo without it
undercuts the backend one.
**Acceptance criteria:**
- Next.js + TS (ESM, strict), `npm run lint` · `typecheck` · `test` all wired and passing empty.
- `.githooks` ported: gitleaks pre-commit, commit-msg hook rejecting AI/co-author trailers.
- CI workflow mirroring the backend's gates + the `SLAI-` PR-title check.
- `docs/engineering-checklist.md` ported, plus a line: *re-diff the copied contract when backend
  response types change.*
- `src/api/contract.ts` holds **every** copied wire type (`CategoriesResponse`, `StatsResponse`,
  `ProfileResponse`, `SuggestionsResponse`, `TransactionsResponse`, `FixedExpensesResponse` and
  their members), with a header comment naming the backend source files and the **commit SHA** they
  were copied from. No wire type is declared anywhere else in the repo.

### SLAI-25 · Supabase Auth + authenticated API client
**Type:** Story · **Labels:** frontend, auth · **Depends on:** SLAI-23, SLAI-24
Everything else depends on this seam.
**Acceptance criteria:**
- Login + signup against Supabase Auth; session persisted, protected routes redirect when absent.
- One `src/api/client.ts` attaches the Supabase access token to every request — **no `fetch` in any
  component**.
- A 401 clears the session and redirects to login; token refresh handled in the client, not per-call.
- Responses typed from `contract.ts`; the error envelope `{ error: { code, message } }` is parsed to
  a typed error, and a 429 from the LLM routes surfaces `Retry-After` as a real message.
- Tested with a stubbed transport — no live Supabase or backend call in tests.

### SLAI-26 · Log daily spend & fixed expenses
**Type:** Story · **Labels:** frontend, api · **Depends on:** SLAI-25
**Acceptance criteria:**
- Forms over `POST /transactions` and `POST /fixed-expenses`; list, edit, delete/deactivate.
- **Money stays integer cents** in state and on the wire — the currency input parses to cents once,
  and formatting happens only at render. No `parseFloat` on an amount reaches state or the API.
- Category select fed by `GET /categories`; field-level 400s render against the offending field.
- Unit-tested incl. the cents-parsing edge cases (`"12.5"`, `"12.345"`, `","` decimal separators).

### SLAI-27 · Dashboard — stats + profile narrative
**Type:** Story · **Labels:** frontend, api · **Depends on:** SLAI-25
**Acceptance criteria:**
- `GET /stats` and `GET /profile` render: totals, per-category shares, top categories,
  recurring-vs-discretionary split, month-over-month delta, and the narrative summary.
- Period selector drives `from`/`to`; empty ledger renders an explicit empty state, not zeros.
- `POST /profile/refresh` triggerable, with pending state and the 429 path handled.
- Every figure displayed comes from the API — **the client performs no money arithmetic.**

### SLAI-28 · Suggestions feed (the grounded view)
**Type:** Story · **Labels:** frontend, agent · **Depends on:** SLAI-27
The screen that makes this a grounded agent rather than a chatbot with a database. Worth more
polish than the rest of the sprint combined.
**Acceptance criteria:**
- `GET /suggestions` renders each suggestion **with its citation visible** — the stat/category it
  rests on shown alongside the claim, not hidden behind a tooltip.
- `estMonthlySavingsCents` displayed as formatted money, taken verbatim from the API.
- Dismiss / apply via `PATCH /suggestions/:id`, with optimistic update and rollback on failure.
- `POST /suggestions/refresh` wired, sharing SLAI-25's 429 handling.
- A suggestion whose citation cannot be resolved renders as degraded — visibly missing its
  grounding — rather than rendering as if it were grounded.

---

# Later sprints (out of scope for now, tracked so the shape is clear)
- **Sprint 4 — Deploy + writeup**: production build (today `npm start` is `tsx` over source and
  `build` is `tsc --noEmit`, emitting nothing) → Dockerfile → Fly/Railway/Render + managed Postgres,
  live URLs, **first live model run + `npm run eval -- --live` baseline**, scheduler wiring the
  in-process job deferred from SLAI-19 (its rate limiter is per-instance — that stops being a
  footnote above one instance), README with real eval numbers as an outreach hook.
- **Later — Mobile** (Expo) on the same API.
