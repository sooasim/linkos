#!/bin/sh
set -e
# Keep idle HTTP connections open longer than common load balancers (60s) so the server never closes a socket
# the balancer/client is about to reuse ("socket hang up" / sporadic 502). Override with KEEP_ALIVE_TIMEOUT.
export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-65000}"
# On Render the public URL is provided as RENDER_EXTERNAL_URL; use it unless APP_ORIGIN is set explicitly.
if [ -z "$APP_ORIGIN" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then export APP_ORIGIN="$RENDER_EXTERNAL_URL"; fi
# CREDENTIALS_KEY must be 32 bytes (base64). A platform-generated secret of another shape is turned into a
# 32-byte key with SHA-256, so a one-click deploy works without hand-made keys.
if [ -n "$CREDENTIALS_KEY" ]; then
  CREDENTIALS_KEY="$(node -e 'const r=process.env.CREDENTIALS_KEY;const b=Buffer.from(r,"base64");process.stdout.write(b.length===32?r:require("crypto").createHash("sha256").update(r).digest("base64"))')"
  export CREDENTIALS_KEY
fi
migrate() { (cd /app/ops && node_modules/.bin/tsx services/api/src/migrate.ts); }
case "$1" in
  web) exec node apps/web/server.js ;;
  migrate) migrate ;;
  worker) cd /app/ops && exec node_modules/.bin/tsx services/api/src/worker.ts ;;
  release) migrate && exec node apps/web/server.js ;;
  # all-in-one for small/free hosting: migrate, run the outbox worker in the background, then serve the web app
  all)
    migrate
    (cd /app/ops && while true; do node_modules/.bin/tsx services/api/src/worker.ts || echo "worker exited, restarting in 5s" >&2; sleep 5; done) &
    exec node apps/web/server.js
    ;;
  *) exec "$@" ;;
esac
