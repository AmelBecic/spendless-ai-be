# The daily loop

Scaffolded with dev-kit. This is how work flows through this repo.

```
   ┌─ Jira ticket (requirements = source of truth)
   │
   ├─▶ git checkout -b feat/TICKET-123-thing
   │
   ├─▶ build the change  (Claude Code follows CLAUDE.md house rules)
   │
   ├─▶ git commit         →  pre-commit gate: secrets · lint · typecheck
   │
   ├─▶ open PR (title includes TICKET-123)
   │
   ├─▶ AI code reviewer runs on the PR   →  code quality + requirement check
   │       (~/Desktop/career-improvement/ai-code-reviewer)
   │
   ├─▶ CI runs the same gates + dependency audit
   │
   ├─▶ merge  →  Mergiraf resolves structural conflicts automatically
   │
   └─▶ metrics captured  →  ~/dev-kit/cockpit.sh   (tokens · cost · velocity)
```

## Commands
| Purpose            | Command                              |
|--------------------|--------------------------------------|
| Secret scan now    | `npm run secrets` / `gitleaks detect`|
| Lint / types       | `npm run lint` · `npm run typecheck` |
| Metrics dashboard  | `~/dev-kit/cockpit.sh [today\|week\|month]` |
| Live usage window  | `npx ccusage blocks`                 |

## Notes
- Conflicts Mergiraf can't safely resolve are left with markers for manual review.
  (Planned: a ticket-aware Claude resolver for those — see dev-workflow-system memory.)
- Never bypass the pre-commit hook (`--no-verify`) without a stated reason.
