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
- [ ] **Edge validation must bound values on BOTH sides, against the column's real limits** — a
      lower bound alone still lets an over-large value through to overflow at the database as a 500,
      which is the exact failure the validation existed to prevent. Prisma `Int` is Postgres **int4**
      (max 2_147_483_647), not bigint. Check the column type, don't assume. (SLAI-9: `amountCents`
      was `.int().positive()` with no `.max()`; 2_147_483_648 → 500.)
- [ ] **Supabase: enable RLS on every `public` table.** The anon/publishable key is public and
      PostgREST exposes `public`; deny-all RLS is fine when the backend connects as the owner (which
      bypasses RLS). Note in a comment that owner/`service_role` (BYPASSRLS) are unaffected.
- [ ] Seeds are idempotent (`upsert`), teardown awaited in `try/catch/finally`.
- [ ] Migrations apply cleanly to an empty DB; no drift (`prisma migrate status` == up to date).

## Data access & multi-tenancy
- [ ] **Never forward a request body / patch object straight into an ORM `data`.** Build the payload
      from known fields. A typed input parameter is a compile-time promise only — an untyped body
      forwarded by a handler lets the caller write `userId` (reassigning a row to another account),
      `id`, or `createdAt`. Applies to **updates as much as creates**; the create path is the one
      people remember to guard. (SLAI-7: real, reproduced — the row moved between users.)
- [ ] Every per-user read/write filters on `userId` **in the same statement** as the id
      (`where: { id, userId }`), so there is no read-then-write window and a foreign row is
      indistinguishable from a missing one.
- [ ] **List methods on tables that grow with use are bounded** (cursor + clamped page size). Ask
      "does this table grow per day of use?" — if yes, unpaged is a slow leak, not a nit.
- [ ] **Catch narrow, and know what the code means.** A broad catch that maps an error to a benign
      empty result hides unrelated failures (SLAI-7: P2023 says "some uuid was unparseable", not
      "the cursor was bad" — it masked a malformed `categoryId` as "no results").
- [ ] **Verify assumed database/ORM behaviour before writing a comment that asserts it** — probe it.
      (SLAI-7: a nonexistent cursor was assumed to throw; it returns an empty page. A doc comment
      promised `ON CONFLICT DO NOTHING` that the ORM does not always emit.)

## Dates & times on the wire
- [ ] **A date-time without `Z` or an offset is parsed as *server-local* time** (a bare `YYYY-MM-DD`
      is UTC) — so the same request means different instants on different hosts, and on a
      positive-offset deployment lands in the previous UTC day. Require the designator on any value
      carrying a time rather than inheriting the server's clock. (SLAI-10.)
- [ ] **An inclusive upper bound given as a bare date must cover its whole day.** `to=2026-07-31`
      parses to 00:00:00Z, so an `lte` filter drops 24 hours and a month's listing silently
      under-reports its last day. Widen to 23:59:59.999Z. Test the `to` side, not just `from` —
      midnight is coincidentally correct for a lower bound, which hides the bug. (SLAI-10.)
- [ ] **`Date.parse` NaN is not a calendar check.** `2026-07-32` yields NaN but `2026-02-31` rolls
      forward to 2026-03-03, filing data under the wrong month. Verify the day against the month's
      real length. (SLAI-10.)

## Secrets & tests
- [ ] No secrets committed; `.env` git-ignored; every key documented in `.env.example`.
- [ ] Unit tests cover the invariants a refactor could silently break (fixed sets, idempotency, guards).
