# Pre-PR engineering checklist

Self-review against this **before opening a PR and before running the AI reviewer**. The reviewer is
a backstop, not your first-pass QA — each run costs real budget, so catch the predictable things here
first. This list grows every time the reviewer catches something that could have been caught up front.

## Process (the expensive mistakes)
- [ ] **Clean-regen the lockfile after ANY dependency change** before committing:
      `rm -rf node_modules package-lock.json && npm install`. Incremental `npm install` on macOS
      drops linux-only optional deps (e.g. `@emnapi/*`) from the lock → CI `npm ci` fails with
      "Missing … from lock file". (Bit us in two separate tickets — verify `grep -c '@emnapi' package-lock.json` > 0.)
- [ ] **Don't review a stale diff.** Before running the reviewer, confirm GitHub has your latest push:
      `gh pr view <n> --json headRefOid -q .headRefOid` == `git rev-parse HEAD`. Reviewing before
      propagation produces phantom findings and wastes a full run.
- [ ] **Batch fixes; minimize reviewer runs.** Fix everything you can find yourself, push once, then
      review. After addressing findings, push all fixes together and re-review **at most once** to
      confirm — never re-run after each individual fix.
- [ ] **Fix anticipated issues now, don't defer them.** If you notice a problem while building, fixing
      it costs less than the reviewer finding it later and you fixing it anyway.

## Errors & observability
- [ ] Never swallow a caught error — log the cause (`catch (err) { log.error({ err }, "...") ; ... }`).
- [ ] Any health/liveness/external call is **bounded by a timeout** so it can't hang.
- [ ] Internal error details never leak to clients in production; one consistent error envelope.

## Runtime & deps
- [ ] Anything `start`/prod runs must be a **runtime dependency**, not a devDependency.
- [ ] Fresh `npm ci` (incl. CI) has everything it needs — codegen wired (e.g. Prisma `postinstall`),
      no reliance on a transitively-hoisted binary.

## Database (Postgres / Prisma / Supabase)
- [ ] **Index FK referencing columns** — Postgres does NOT auto-index them; unindexed FKs seq-scan on
      parent delete/update and on category-style filters.
- [ ] **`@@unique`** wherever "one row per X" is intended (and the writer upserts).
- [ ] Money is **int cents + 3-char currency**, never float; add DB **CHECK constraints**
      (amount > 0, `char_length(currency) = 3`, non-negative where intended) as defence-in-depth.
- [ ] **Supabase: enable RLS on every `public` table.** The anon/publishable key is public and
      PostgREST exposes `public`; deny-all RLS is fine when the backend connects as the owner (which
      bypasses RLS). Note in a comment that owner/`service_role` (BYPASSRLS) are unaffected.
- [ ] Seeds are idempotent (`upsert`), teardown awaited in `try/catch/finally`.
- [ ] Migrations apply cleanly to an empty DB; no drift (`prisma migrate status` == up to date).

## Secrets & tests
- [ ] No secrets committed; `.env` git-ignored; every key documented in `.env.example`.
- [ ] Unit tests cover the invariants a refactor could silently break (fixed sets, idempotency, guards).
