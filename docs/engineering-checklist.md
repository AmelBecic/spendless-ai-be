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

- [ ] **A date-time without `Z` or an offset is parsed as _server-local_ time** (a bare `YYYY-MM-DD`
      is UTC) — so the same request means different instants on different hosts, and on a
      positive-offset deployment lands in the previous UTC day. Require the designator on any value
      carrying a time rather than inheriting the server's clock. (SLAI-10.)
- [ ] **An inclusive upper bound given as a bare date must cover its whole day.** `to=2026-07-31`
      parses to 00:00:00Z, so an `lte` filter drops 24 hours and a month's listing silently
      under-reports its last day. Widen to 23:59:59.999Z. Test the `to` side, not just `from` —
      midnight is coincidentally correct for a lower bound, which hides the bug. (SLAI-10.)
- [ ] **`createdAt` is not a domain date.** It records when a row was entered, not when the thing it
      describes began. Filtering a historical aggregate on it looks principled and silently empties
      the past: a user who types in standing rent today gets zero recurring spend for every prior
      period. If the domain needs "when did this start", add `startedAt`/`endedAt` — don't proxy it.
      (SLAI-11: caught only by an integration test, because unit fixtures set `createdAt` by hand and
      every real row gets `now()`.) The mirror case is a **boolean status flag read as though it had
      always held** — filtering history on `active` empties closed periods of things that were
      genuinely paid then, so an aggregate over a closed period silently changes when a user edits a
      row today. Both directions are the same missing `startedAt`/`endedAt` pair.
- [ ] **Aggregates must read every page.** A total over one page of a cursor-paged repository is just
      a wrong number. Walk the cursor, and bound the walk with an error rather than a silent
      truncation — a capped total is indistinguishable from a real one. (SLAI-11.)
- [ ] **`Date.parse` NaN is not a calendar check.** `2026-07-32` yields NaN but `2026-02-31` rolls
      forward to 2026-03-03, filing data under the wrong month. Verify the day against the month's
      real length. (SLAI-10.)

## LLM agents (grounding & cost)

- [ ] **Whatever the prompt renders, the grounding scan must allow back.** An allow-list built from
      one source while the payload shows another rejects the model for faithfully quoting a figure
      this code handed it. Cross-check the allow-list against the _payload builder_, not against the
      type the figures came from. (SLAI-18: the payload rendered `discretionaryByCategory` totals and
      commitment amounts; the scan only allowed `SpendStats`.)
- [ ] **A grounding fixture must not let the expected figure coincide with an allowed one.** A single
      category whose total equals `discretionaryTotal`, or a percentage that matches the daily
      average, passes with the bug still in. Pick values that appear in exactly one place, and prove
      the test fails when the fix is reverted. (SLAI-18: caught twice — the reviewer found the first,
      and reverting the fix showed the replacement test still passed.)
- [ ] **Don't enforce a list cap in the response schema.** `.max()` fails the whole parse, so one
      over-eager completion costs every good item in it plus the spend. Truncate after parsing and
      record the excess like any other dropped item. (SLAI-18.)
- [ ] **A "cheapest guard" that keys on written rows never fires when the pass writes none.** An empty
      outcome leaves nothing to short-circuit on, so the user likeliest to produce no output is the
      one who pays for a completion on every retry. Record _that a pass ran_, separately from what it
      produced. (SLAI-18: partly deferred to SLAI-19 — needs a table.)
- [ ] **Compute money in code, never in the completion** — give the model a qualitative lever and
      keep the rates as constants. And bound the computed figure: a rate scaled up from a partial
      period can exceed int4 even when every input is valid.

## Evals & harnesses

- [ ] **A harness must not hold its own copy of a production guard.** Reimplementing the condition
      means the harness scores itself: the service can move the model call above the emptiness check,
      or flip `&&` to `||`, and every case still passes. Extract the predicate and have both call it.
      (SLAI-20: `hasAnythingToAdvise`, caught in round two.)
- [ ] **A deny-list regex over model prose needs an advisory context, not a bare noun.** The nouns
      collide with the product's own vocabulary — a bare `shares?` rejects "share the subscription
      with a housemate", a bare `tax` rejects "your transport spend includes road tax". When the
      metric is baselined at 1.0, one false positive fails the build for a _correct_ answer, which is
      the costliest direction to be wrong in. (SLAI-20.)
- [ ] **A metric baselined as `n/a` is ungated unless you say otherwise.** "Did the number fall?"
      never fires when there was no number. Decide explicitly what a `null → value` transition means,
      and flag a metric that stopped being measured too — otherwise deleting a check reads as "no
      regression" forever. (SLAI-20.)
- [ ] **One failing case must not abort the run.** An unguarded `await` in the loop discards every
      score already computed and prints nothing — in a live/billable harness that throws away real
      money on a single 429. Record a hard zero with the reason and keep going; exit non-zero for
      "harness broke" distinctly from "scores regressed". (SLAI-20.)
- [ ] **Prove the harness fails.** A suite that reports 100% on a healthy tree has demonstrated
      nothing. Break one property, watch the matching metric — and only that one — drop, then revert.
- [ ] **Recount the fixtures in the docs before opening the PR.** When the README numbers _are_ the
      deliverable, prose saying "five cases" over a six-case baseline is a defect in the thing being
      shipped, not a typo. (SLAI-20: added a sixth case during review and left the count stale.)
- [ ] **The first run of a mode has no baseline.** Reading it with no existence check dies on a raw
      ENOENT after all the work is done; print the command that records one. (SLAI-20.)

## Rate limiting & in-memory guards

- [ ] **A bounded cache's eviction policy is a security decision, not housekeeping.** Evicting the
      oldest entry is the obvious choice and it is a bypass: a caller who has spent their budget can
      push `maxKeys` distinct keys through the limiter to evict *their own* counter and get a fresh
      allowance — and their counter, being the longest-lived, is the first one an oldest-first policy
      drops. Evict the **newest** so a flood displaces only itself. A wholesale `clear()` on overflow
      is worse still: it forgives every live caller at once. (SLAI-19: written oldest-first, caught
      by a test that filled past `maxKeys` and re-checked the exhausted caller.)
- [ ] **Rate-limit *after* authentication, and key on the user.** Limiting before identity is known
      buckets every anonymous caller together, so any one of them can lock out the rest.
- [ ] **Routes that draw on the same paid resource share one budget.** Metering each separately lets
      a caller alternate between them and spend N times the intended ceiling.
- [ ] Say in a comment whether an in-process counter is per-instance, and whether that is a trade or
      an oversight — N instances allow N times the limit, and the next reader cannot tell which was
      meant.

## Concurrency

- [ ] **Read-then-write across a slow call is not an invariant.** Two requests both clear an existence
      check and both insert. If the invariant is "one set per X" and a set is several rows, a unique
      constraint cannot express it — serialise on the parent row (`SELECT … FOR UPDATE` inside the
      transaction) instead. Never hold a transaction open across a model call. (SLAI-18.)
- [ ] Prove a concurrency fix by removing it and watching the test fail — a passing test around a race
      proves nothing on its own.
- [ ] **A marker written _before_ paid work is a mutex; written _after_, it is a receipt. Pick on
      purpose.** They are one row apart and behave differently under a race: as a pre-claim the loser
      must be handed an empty result, which silently breaks a "the loser gets the winner's rows"
      contract established elsewhere. If the write is already serialised (a row lock), the receipt is
      what you want — the marker's job is the *retry hours later*, not the race. And record only on
      success, or one transient failure marks the day done and the user gets nothing until midnight.
      (SLAI-19: shipped as a pre-claim, caught by SLAI-18's existing race test.)

## Config & fixtures

- [ ] **Centralise the config fixture before adding the second key, not the fifteenth.** A typed
      `Env` literal copy-pasted across suites means every new variable is a compile error in a dozen
      files, and the mechanical fix buries the real diff. One `testEnv(overrides)` helper keeps a new
      key arriving in tests with the same default production gives it. (SLAI-19: four new vars broke
      13 suites.)
- [ ] **A "no real values" guard on `.env.example` must still allow inert ones.** Blanking a tuning
      knob like `REFRESH_RATE_LIMIT=10` costs the reader the documented default for no security gain
      — a bare number or boolean cannot encode a credential. Widen the allow-list deliberately rather
      than emptying the template.

## Secrets & tests

- [ ] No secrets committed; `.env` git-ignored; every key documented in `.env.example`.
- [ ] Unit tests cover the invariants a refactor could silently break (fixed sets, idempotency, guards).
