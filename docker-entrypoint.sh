#!/bin/sh
set -e

# Apply any pending migrations before the app accepts traffic. `migrate deploy` is
# idempotent and never generates or prompts (unlike `migrate dev`); it uses
# DIRECT_URL when set, falling back to DATABASE_URL. Sprint 4 runs a single
# instance, so there is no concurrent-migration race to guard against yet.
echo "==> prisma migrate deploy"
npx prisma migrate deploy

echo "==> starting server"
exec "$@"
