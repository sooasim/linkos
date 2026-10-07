#!/bin/sh
set -e
# Keep idle HTTP connections open longer than common load balancers (60s) so the server never closes a socket
# the balancer/client is about to reuse ("socket hang up" / sporadic 502). Override with KEEP_ALIVE_TIMEOUT.
export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-65000}"
case "$1" in
  web) exec node apps/web/server.js ;;
  migrate) cd /app/ops && exec node_modules/.bin/tsx services/api/src/migrate.ts ;;
  worker) cd /app/ops && exec node_modules/.bin/tsx services/api/src/worker.ts ;;
  release) cd /app/ops && node_modules/.bin/tsx services/api/src/migrate.ts && cd /app && exec node apps/web/server.js ;;
  *) exec "$@" ;;
esac
