# SpendLess AI — backend

A multi-tenant API for a **grounded personal-finance profiling agent**. Users log their fixed monthly
expenses and day-to-day spending; the service computes deterministic spend statistics, maintains an
incrementally-updated per-user profile, and produces savings suggestions that cite the numbers they
rest on.

The governing rule: **numbers are always computed in code — the LLM interprets, it never does
arithmetic.** Every figure a suggestion quotes traces back to a value this service calculated.

> **Status:** Sprint 1 (foundation) is landing — database, auth, CRUD and deterministic stats. The
> agent loop, suggestions and eval harness are Sprint 2. See [`docs/backlog.md`](docs/backlog.md).

## Stack

Node 24+ / TypeScript (ESM) · [Fastify](https://fastify.dev) · [Prisma](https://www.prisma.io)
migrations over Supabase Postgres · Supabase Auth (JWT verified in-process) · Vitest.

## Architecture

Request flow, and where each concern lives:

```
server.ts        process entrypoint — loads env, opens the pool, listens
  └── app.ts     builds the Fastify instance (no port) so tests drive it via `inject`
        ├── auth/          JWT verification (JWKS) → req.user, with profile provisioning
        ├── routes/        HTTP surface: validation, status codes, error envelope
        ├── repositories/  data access — every query scoped by `userId`
        ├── agent/         deterministic aggregation (stats), later the LLM loop
        └── domain/        shared vocabulary: types, Money helpers, categories
```

The seams that matter:

- **`app.ts` builds, `server.ts` listens.** Tests import the app and inject requests — no port, no
  real database, dependencies passed in as stubs.
- **Repositories are the isolation boundary.** Every per-user read and write filters on `userId` in
  the same statement as the row id, so a foreign row is indistinguishable from a missing one.
- **Env is parsed once** through a typed zod schema in `config/env.ts`; nothing downstream reads
  `process.env`. A misconfigured deploy fails fast at boot with every offending var named.
- **One error envelope.** Everything leaves as `{ error: { code, message } }`; internals never leak
  in production.
- **Money is integer cents + a 3-char currency**, never a float, and mixed-currency arithmetic
  throws rather than silently producing a wrong total.

## Cost guardrails

Every profile and suggestion refresh is a paid model call, so the app is built so that the *absence*
of user activity costs nothing. Three independent guards:

**1. Idle users are skipped.** The daily job measures each user against their last summary's
`createdAt` — "has anything been entered since we last looked?" — counting both new transactions and
changed commitments. A user who has done nothing buys no completion; the check is two indexed counts.
A user who has never been summarised is measured from the epoch, so an empty account is idle too and
a fresh signup list costs nothing to walk.

**2. One pass per user per day, recorded independently of its output.** `agent_runs` records *that* a
pass ran. A guard keyed on the rows a pass wrote can never fire for a pass that legitimately writes
none — which makes the user with the least to advise on the one who pays on every retry. Recording
only on success keeps a transient failure to a retry rather than losing the user their day.

**3. A per-user rate limit on the paid routes.** `POST /profile/refresh` and `POST /suggestions/refresh`
share one budget per user (they draw on the same model, so metering them separately would let a
caller alternate and spend twice the ceiling). Exceeding it is a `429` in the standard error envelope
with a `Retry-After` header, refused before the model is reached. The counter is in-process and
per-instance — a deliberate trade, since a shared counter needs Redis and this sprint takes on no
external infrastructure. It bounds "one user holding down a button", not a precise quota.

Beyond those, every model call is bounded by the SDK's own timeout (2 min per attempt, 3 attempts),
and each user's whole refresh is bounded again at the job level so one wedged user cannot stall the
pass behind them.

### The daily refresh job

An in-process interval owned by the server process — no external scheduler, no queue. It is **off by
default**, because it spends money in the background and running the app locally against a real key
should not start it:

```bash
DAILY_REFRESH_ENABLED=true
DAILY_REFRESH_INTERVAL_MINUTES=1440   # once a day
```

A pass never overlaps itself: if one run is still going when the next tick fires, the tick is
dropped. One user's failure is logged and counted, and the walk continues — a job that aborted on the
first bad user would leave everyone behind them stale and discard the completions already paid for.
Users are walked **sequentially and deliberately**: the cached prompt prefix has a five-minute TTL,
so back-to-back calls read the prefix from cache instead of rewriting it at ~1.25× input price. The
prefix is a per-agent constant carrying no user data, which is what makes it reusable across users.

`runDailyRefresh` is exported separately from the interval that drives it, so the same pass can be
triggered by an external cron later without changing the job. Deploy wiring is Sprint 4.

## Running locally

**Prerequisites:** Node ≥ 24 and a Postgres database (Supabase, or any local instance).

```bash
git clone git@github.com:AmelBecic/spendless-ai-be.git
cd spendless-ai-be
npm install                 # `postinstall` runs `prisma generate`

cp .env.example .env        # then fill in the real values — see below
npm run db:deploy           # apply migrations
npm run db:seed             # seed the category catalogue (idempotent)

npm run dev                 # http://localhost:3000 — tsx watch
curl localhost:3000/health  # {"status":"ok"}
```

### Configuration

Every variable is documented in [`.env.example`](.env.example); `.env` is git-ignored and must never
be committed. `DATABASE_URL` is required to boot, and `SUPABASE_URL` is additionally required by
`server.ts` to verify auth tokens. `SUPABASE_JWKS_URL` is optional — it defaults to
`<SUPABASE_URL>/auth/v1/.well-known/jwks.json` and only needs setting for a non-standard endpoint.

A test asserts `.env.example` and the env schema stay in sync, so a newly-added variable cannot ship
undocumented.

### Everyday commands

| Command                              | What it does                                                              |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `npm run dev`                        | Run with reload (`tsx watch`)                                             |
| `npm test`                           | Vitest — unit suites; integration suites skip without `TEST_DATABASE_URL` |
| `npm run lint` / `npm run typecheck` | The quality gates CI enforces                                             |
| `npm run eval`                       | Score the agent against the fixtures in `evals/` — see below              |
| `npm run secrets`                    | gitleaks scan (also runs in the pre-commit hook)                          |
| `npm run db:migrate`                 | Create + apply a migration in development                                 |
| `npm run db:studio`                  | Browse the database                                                       |

Integration tests run against a **disposable** Postgres — the harness refuses a `TEST_DATABASE_URL`
that matches `DATABASE_URL` or whose database name doesn't contain `test`. Setup is in
[`docs/testing.md`](docs/testing.md).

## Evals

The agent is scored, not vibed. `npm run eval` runs every case in [`evals/`](evals/), prints a
per-case and aggregate score, and **exits non-zero if any score has fallen** against the committed
baseline in [`evals/baseline.json`](evals/baseline.json).

Each mode keeps its own baseline — `baseline.json` for `stub`, `baseline.live.json` for `--live` —
so re-recording a live run cannot overwrite the stub gate. Re-record with
`npm run eval -- --update-baseline` (add `--live` for the live one). Exit codes: `0` clean, `1`
regressed, `2` the harness itself failed.

### The five metrics

| Metric                | What it asks                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grounding`           | Does every `sourceRef` name a stat that exists, and does the prose contain only figures the model was shown?                         |
| `correctness`         | Do the computed stats and every quoted saving equal the hand-computed expected value?                                                |
| `actionability`       | Is each suggestion a short, non-empty instruction that names the category or commitment it is about?                                 |
| `safety`              | Does it stay inside spending advice, never price a cancelled or foreign-currency commitment, and propose no target it was not shown? |
| `gracefulDegradation` | Do the empty, idle and mixed-currency ledgers end the right way — and **without buying a completion**?                               |

Every check is deterministic, computed from expectations written by hand in
[`evals/cases.ts`](evals/cases.ts) with the arithmetic shown. **Nothing here asks a model to grade a
model:** an LLM judge shares the failure modes of the thing it is judging, and the two properties
that matter most — that a quoted figure is real and that a cited stat exists — are exactly checkable.
A metric scores `n/a` rather than a free 1.0 on a case that gives it nothing to measure, so a
grounding regression cannot hide inside an average padded by cases that never called the model.

### Seed numbers

Six synthetic users:

| Case                    | What it covers                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `steady-eater`          | Food-heavy discretionary spend plus two live commitments — the ordinary path          |
| `commitments-only`      | Nothing to trim, one thing to cancel                                                  |
| `returning-user`        | An existing profile summary — the branch that renders a real profile into the payload |
| `empty-ledger`          | A new user: no transactions, no commitments                                           |
| `no-new-activity`       | History exists but the current period is idle                                         |
| `mixed-currency-ledger` | An active commitment outside the ledger currency — must be refused, not converted     |

| Mode              | grounding | correctness | actionability | safety | gracefulDegradation | overall |
| ----------------- | --------- | ----------- | ------------- | ------ | ------------------- | ------- |
| `stub` (6 cases)  | 100.0%    | 100.0%      | 100.0%        | 100.0% | 100.0%              | 100.0%  |
| `live` (`--live`) | —         | —           | —             | —      | —                   | —       |

The `live` row is empty because this repo has no `ANTHROPIC_API_KEY` yet: the harness supports the
mode and the seam is exercised by the stub, but no scored run against the real model has happened, so
there is no number to publish. It is not a 0 and it is not a 100 — it is unmeasured.

Read the stub number for what it is. With the model scripted, the scorers measure **the code**: the
arithmetic behind every figure, the grounding checks, and the guards that decide whether a completion
is bought at all. That is a real regression gate — dropping `TRIM_RATES.moderate` from `0.2` to `0.25`
takes `steady-eater / correctness` to 88.9% and exits 1 — and it is deterministic, free, and safe for
CI. What it does _not_ measure is the prompt. `npm run eval -- --live` runs the identical scorers
against the real model, which is what grades whether Opus cites real stats and stays in its remit;
those numbers are baselined separately (`--update-baseline`) because the two modes are not
comparable, and the harness refuses to compare them.

## Contributing

Work is tracked in Jira (project `SLAI`) and mirrored in [`docs/backlog.md`](docs/backlog.md), which
holds the acceptance criteria in full. The workflow is non-negotiable and documented in
[`CLAUDE.md`](CLAUDE.md):

- Never commit to `main` — feature branch → PR → review → merge.
- PR titles start with the ticket key (`SLAI-12 …`); CI enforces it.
- `npm run lint && npm run typecheck && npm run test` must pass before pushing; CI runs the same
  gates against an ephemeral Postgres, plus a gitleaks scan.
- Self-review against [`docs/engineering-checklist.md`](docs/engineering-checklist.md) before opening
  a PR — it accumulates every class of bug that has been caught here before.
