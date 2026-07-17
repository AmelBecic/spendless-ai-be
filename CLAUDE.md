# Project house rules

> Scaffolded with [dev-kit](~/dev-kit). These rules apply to this repo.

## Workflow (non-negotiable)
- **Never commit directly to `main`.** Every change: feature branch → PR → review → merge.
- Branch names: `feat/TICKET-desc`, `fix/TICKET-desc`, `chore/desc`.
- Run the **AI code reviewer** on the PR before merging.
- Merges use **Mergiraf** (syntax-aware) — configured globally; conflicts it can't resolve get manual review.

## Security
- **No secrets in the repo, ever.** Real values go in `.env` (git-ignored). Document required keys in `.env.example`.
- The **pre-commit hook** runs `gitleaks` — a commit containing a secret is blocked.
- Do not disable or bypass the hooks (`--no-verify`) without a stated reason.

## Quality gates (run before pushing)
- `npm run lint` · `npm run typecheck` · `npm run test`
- CI (`.github/workflows/ci.yml`) enforces the same gates on every PR.

## Conventions
- TypeScript, ESM, small focused modules.
- Match existing code style; keep comment density consistent with surrounding code.
- Prefer clarity over cleverness.

## Ticket context
- Source of truth for requirements is the linked **Jira** ticket. Reference the ticket key in the branch and PR title.
