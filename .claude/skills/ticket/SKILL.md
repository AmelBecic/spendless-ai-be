---
name: ticket
description: Run one Jira ticket end-to-end — pick it up, branch, implement against the acceptance criteria, verify, gate, PR, run the AI code reviewer, and update Jira. Use when the user says "/ticket", "take the next ticket", "work <KEY>-24", "start the next story", or asks to pick up / work / drive a ticket through to review.
---

# Run a ticket end-to-end

One invocation carries a ticket from `To Do` to `In Review` with a reviewed PR open. The user
should not have to say "now branch", "now review it", or "now update Jira" — those are steps here,
not requests.

**Argument:** a ticket key (`/ticket SPEND-24`) or nothing (`/ticket` → take the next one).

## Step 0 — Load the repo's config (always first)

Read **`.claude/project.json`** in the repo root. It provides every project-specific value below:

- `jiraKey` — the Jira project key (e.g. `SPEND`). **Never assume `TRIP`.**
- `cloudId` — Atlassian cloudId for the MCP calls.
- `boardId` — the board.
- `ticketFilterJql` — if set, an extra JQL fragment ANDed into the pick queries so this repo owns
  only its own tickets (e.g. `labels = backend`). One Jira project can drive several repos; a repo
  must only pick up **its own** slice. Works for team-managed projects (labels) and company-managed
  (`component = "..."`) alike.
- `reviewerPath` — where the AI code reviewer lives.
- `assigneeAccountId` — the human this work is assigned to.
- `transitions` — status transition IDs (`todo`/`inProgress`/`inReview`/`done`). **Verify them once**
  against `getTransitionsForJiraIssue` on a real ticket if the loop ever fails to transition — IDs
  can differ per project.

If `.claude/project.json` is missing or still has `FIXME` values, **stop and ask** — the loop can't
run without it.

## Step 1 — Reconcile drift (before anything else)

Statuses lie when the loop half-ran. Query (substitute `<KEY>` and, if set, `ticketFilterJql`):

```
project = <KEY> AND status = "In Review"    [AND <ticketFilterJql>]
```

For each hit, check its PR (`gh pr list --search "<TICKET>" --state all`). **If the PR is MERGED,
transition the ticket to Done** and move on. This is a known recurring gap. Report what you reconciled.

## Step 2 — Preflight

- `git status --short` must be clean. If not, **stop and ask** — never stash or discard.
- `git checkout main && git pull`. Delete merged local branches if they clutter.
- If the working tree is mid-ticket on a feature branch, ask before abandoning it.

## Step 3 — Pick the ticket

Given a key, use it. Otherwise:

```
project = <KEY> AND status = "To Do" AND issuetype != Epic [AND <ticketFilterJql>] ORDER BY key ASC
```

Take the lowest key. **Respect `Depends on`** in `docs/backlog.md` — if a dependency isn't `Done`,
skip to the next eligible ticket and say why. Never take an Epic. If nothing is eligible, say so and
stop. Don't invent work.

## Step 4 — Read the requirements

Get the ticket (`getJiraIssue`) **and** its section in `docs/backlog.md` — the backlog holds the
acceptance criteria in full. **The AC is the spec**; the reviewer will check the PR against it, so
re-read it before writing code and again before opening the PR. If the AC is ambiguous or looks
wrong, **stop and ask** — a misread AC costs a whole loop.

## Step 5 — Start

- **Assign to `assigneeAccountId`** — every ticket, every time. An in-flight ticket with no assignee
  is the same bug as one `In Progress` with no branch.
- Transition to **In Progress**.
- Branch: `feat/<KEY>-<n>-<short-desc>` (`fix/` for Bug, `chore/` for chore-labelled).

## Step 6 — Build

Follow the repo's **`CLAUDE.md`** house rules and match existing patterns. Work through the AC bullet
by bullet — every bullet must be satisfiable by something you can point at in the diff.

## Step 7 — Verify it actually works

Invoke the **`verify`** skill, or drive the app via the **`run`** skill. Tests passing is not
verification — exercise the behaviour the AC describes and observe it.

## Step 8 — Gates

Run the repo's quality gates (from `package.json` scripts / `CLAUDE.md` — typically
`npm run lint && npm run typecheck && npm run test`). **All must pass before committing.** Never
`--no-verify`.

## Step 9 — Commit & PR

- Commit: `feat: <KEY>-<n> <what changed>` (or `fix:` / `docs:` / `chore:`).
- Push, then `gh pr create`.
- **PR title must start with `<KEY>-<n>`** (the `pr-title` CI check fails otherwise).
- PR body: what changed, and the AC as a checklist so the reviewer can check fulfilment.

## Step 10 — Review (do not skip, do not ask permission)

```bash
cd <reviewerPath>
npm run review -- --pr <pr-url> --post
```

The reviewer reads Jira live from its own `.env` — **never** pass `--jira`. This is the step that was
always manual; if a PR was opened in step 9, it runs. Then **triage the findings yourself**:
- Real bugs / AC misses → fix on the branch, push, re-run the review.
- Disagree → say so explicitly with a reason. Don't silently ignore.
- Reviewer approving its own author's PR degrades to COMMENT — expected, not a failure.

## Step 11 — Hand back

- Transition to **In Review**.
- Comment on the ticket with the PR link + the review verdict (`addCommentToJiraIssue`).
- **Stop here.** Merging is the human's call — report and wait.

Then tell the user, in plain prose: ticket, what you built, the review verdict, anything you pushed
back on, and the PR link. Not a wall of tool output.

## After they merge

Transition to **Done**. If they say "merge it" and you merge, do this immediately — that's the drift
step 1 exists to clean up.

## Failure rules

- Gates fail → fix and retry. Twice failing the same way → stop and report.
- Never leave a ticket `In Progress` with no branch, an in-flight ticket unassigned, or a merged PR
  not `Done`.
- Anything hard to reverse (force-push, merge, closing a PR, touching `main`) → ask first.
