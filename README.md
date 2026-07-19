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
| `npm run secrets`                    | gitleaks scan (also runs in the pre-commit hook)                          |
| `npm run db:migrate`                 | Create + apply a migration in development                                 |
| `npm run db:studio`                  | Browse the database                                                       |

Integration tests run against a **disposable** Postgres — the harness refuses a `TEST_DATABASE_URL`
that matches `DATABASE_URL` or whose database name doesn't contain `test`. Setup is in
[`docs/testing.md`](docs/testing.md).

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
