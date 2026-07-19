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
- **Commit messages carry no AI/co-author attribution** (no `Co-Authored-By: Claude`, no
  "Generated with Claude" line). History reads as authored solely by the committer — enforced by
  the `commit-msg` hook, so don't add such trailers.

## Tooling
- **Serena MCP is configured for this repo — use it to navigate code.** Prefer
  `get_symbols_overview` / `find_symbol` over reading a file end-to-end, and
  `find_referencing_symbols` before changing any shared signature or exported type.
- Plain `Read` is still correct for whole small files, configs, docs, and diffs. Symbol lookup is
  for navigating code, not a blanket replacement for reading it.
- Serena's config lives at **local scope** (`~/.claude.json`), so it is *not* checked in — a fresh
  clone or another machine needs `claude mcp add serena` again. Re-run `serena project index` after
  large refactors.

## Ticket context
- Source of truth for requirements is the linked **Jira** ticket. Reference the ticket key in the branch and PR title.
