#!/usr/bin/env bash
# Test server inside a codespace: migrate, outbox worker, web on :3000 (demo login on, no mail server needed).
set -uo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://linkos:linkos@localhost:5432/linkos}"
PORT="${PORT:-3000}"

# Secrets are generated once per codespace and kept out of git.
SECRETS=.devcontainer/.secrets
if [ ! -f "$SECRETS" ]; then
  (umask 077; { echo "AUTH_SECRET=$(openssl rand -hex 32)"; echo "CREDENTIALS_KEY=$(openssl rand -base64 32)"; } > "$SECRETS")
fi
set -a; . "$SECRETS"; set +a

# URL of the forwarded port, e.g. https://name-3000.app.github.dev
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  export APP_ORIGIN="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  export APP_ORIGIN="${APP_ORIGIN:-http://localhost:${PORT}}"
fi
export DEMO_LOGIN=1 BILLING_ENFORCEMENT=off KEEP_ALIVE_TIMEOUT=65000 NEXT_TELEMETRY_DISABLED=1

echo "waiting for Postgres…"
for _ in $(seq 1 60); do
  (cd services/api && node -e 'const c=new (require("pg").Client)(process.env.DATABASE_URL);c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))') 2>/dev/null && break
  sleep 2
done

# Rebuild when the checkout moved since the last build (e.g. after git pull).
if [ ! -f apps/web/.next/BUILD_ID ] || [ "$(cat apps/web/.next/BUILT_FROM 2>/dev/null)" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
  pnpm install --frozen-lockfile && pnpm build && git rev-parse HEAD > apps/web/.next/BUILT_FROM
fi

pnpm db:migrate || { echo "migration failed"; exit 1; }

(while true; do pnpm exec tsx services/api/src/worker.ts || echo "worker exited, restarting in 5s"; sleep 5; done) &

pnpm --filter @linkos/web start -p "$PORT" &
WEB=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null && break; sleep 2; done
echo "LINKOS is up: ${APP_ORIGIN}  (log in with \"테스트 계정으로 바로 시작\")"
wait "$WEB"
