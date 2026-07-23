# Deploying the backend to Railway (SLAI-31)

The backend ships as a Docker image. Railway builds the `Dockerfile`, whose entrypoint runs
`prisma migrate deploy` and then starts the compiled server (`node dist/server.js`). Config lives in
`railway.json` (Dockerfile builder, `/health` healthcheck, **single replica**, restart-on-failure).

**Single instance is deliberate.** The daily-refresh job and the refresh rate limiter (SLAI-19) are
per-instance, so `numReplicas` stays `1` until that state is moved to a shared store. Don't scale out.

The database is **Supabase Postgres** (already provisioned) — Railway runs only the app, no DB added.

---

## 1. Environment variables

Set these on the Railway service (Variables tab, or `railway variables set`). Railway injects `PORT`
itself — **do not set it**; the app reads it and listens on `0.0.0.0:$PORT`.

| Variable                | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `NODE_ENV`              | `production`                                                          |
| `DATABASE_URL`          | Supabase **pooled** connection string (pgBouncer, port `6543`)        |
| `DIRECT_URL`            | Supabase **direct** connection string (port `5432`) — used by migrations |
| `SUPABASE_URL`          | Supabase project URL (`https://<ref>.supabase.co`) — JWKS is derived from it |
| `SUPABASE_ANON_KEY`     | Supabase anon/publishable key                                         |
| `ANTHROPIC_API_KEY`     | Anthropic key — set it so AI mode is on and the live eval (SLAI-32) can run. Leave unset to deploy in no-AI mode. |
| `CORS_ALLOWED_ORIGINS`  | The web origin, comma-separated. Set the Vercel URL once it exists (SLAI-33); until then a placeholder is fine. |
| `DAILY_REFRESH_ENABLED` | `true` to run the in-process daily refresh (optional; needs a key).   |

`DATABASE_URL` = pooled and `DIRECT_URL` = direct is the important pairing: the app runs its queries
through pgBouncer, and Prisma migrations need the direct connection. Both are in the Supabase
dashboard under **Connect**.

## 2. Deploy

**Option A — Railway CLI** (run these yourself; `login` opens a browser):

```bash
railway login
railway init            # or: railway link   (to an existing project)
railway up              # builds the Dockerfile and deploys
```

**Option B — Dashboard:** New Project → Deploy from GitHub repo → pick `AmelBecic/spendless-ai-be` →
add the variables above → deploy. Railway reads `railway.json` for the build + healthcheck.

Generate a public domain (Settings → Networking → Generate Domain) to get the API URL.

## 3. Verify (SLAI-31 acceptance)

Against the generated `https://<app>.up.railway.app`:

```bash
curl -s https://<app>.up.railway.app/health          # -> {"status":"ok"}
curl -s https://<app>.up.railway.app/capabilities     # -> {"ai":true|false}
```

Then smoke the non-LLM routes with a real Supabase JWT: signup/login, create a transaction and a
fixed expense, and `GET /stats`. All should succeed. The first live *model* run is SLAI-32.

If `/health` returns 503, the app booted but can't reach the DB — check `DATABASE_URL`. If the deploy
fails during release, check the `migrate deploy` step in the logs (`DIRECT_URL`).
