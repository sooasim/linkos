#!/bin/sh
set -e
case "$1" in
  web) exec node apps/web/server.js ;;
  migrate) cd /app/ops && exec node_modules/.bin/tsx services/api/src/migrate.ts ;;
  worker) cd /app/ops && exec node_modules/.bin/tsx services/api/src/worker.ts ;;
  release) cd /app/ops && node_modules/.bin/tsx services/api/src/migrate.ts && cd /app && exec node apps/web/server.js ;;
  *) exec "$@" ;;
esac
