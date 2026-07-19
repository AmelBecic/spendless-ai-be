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

Five synthetic users: an ordinary food-heavy ledger, one with commitments but no day-to-day spend,
an empty ledger, an idle period with prior history, and a ledger carrying a foreign-currency
commitment.

| Mode              | grounding | correctness | actionability | safety | gracefulDegradation | overall |
| ----------------- | --------- | ----------- | ------------- | ------ | ------------------- | ------- |
| `stub` (5 cases)  | 100.0%    | 100.0%      | 100.0%        | 100.0% | 100.0%              | 100.0%  |
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
