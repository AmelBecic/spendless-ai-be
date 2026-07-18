# Testing

## Unit tests (default)

```bash
npm test
```

Runs the unit tests. **No database or production credentials required** — integration suites skip
automatically when `TEST_DATABASE_URL` is unset.

## Integration tests (against a disposable Postgres)

Integration specs (`*.integration.test.ts`) run against a **throwaway** Postgres — never the real
database. `resetDb()` `TRUNCATE`s every table between tests, and the harness refuses any
`TEST_DATABASE_URL` that equals `DATABASE_URL` or whose database name doesn't contain `test`.

**In CI** this is a Postgres service container — nothing to do.

**Locally**, point `TEST_DATABASE_URL` at a disposable database, apply the migrations, then run tests:

```bash
# 1. A throwaway Postgres (Docker example)
docker run -d --name spendless-test-db -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -e POSTGRES_DB=spendless_test -p 5432:5432 postgres:16

# 2. Point the harness at it and apply migrations
export TEST_DATABASE_URL="postgresql://test:test@localhost:5432/spendless_test"
DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" npx prisma migrate deploy

# 3. Run the suite (integration specs now execute)
DATABASE_URL="$TEST_DATABASE_URL" npm test
```

Any local Postgres works — the Docker container is just the simplest disposable option.
