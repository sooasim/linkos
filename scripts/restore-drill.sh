#!/usr/bin/env bash
# F-184/F-186 restore drill: back up DATABASE_URL, restore into a scratch DB, compare row counts of core tables.
# Usage: DATABASE_URL=postgres://.../linkos ADMIN_URL=postgres://.../postgres scripts/restore-drill.sh
set -euo pipefail
: "${DATABASE_URL:?}" "${ADMIN_URL:?}"
WORK="$(mktemp -d)"
START=$(date +%s)
FILE="$(scripts/backup.sh "$WORK")"
sha256sum -c "$FILE.sha256" >/dev/null
DRILL_DB="linkos_drill_$(date +%s)"
psql "$ADMIN_URL" -qc "CREATE DATABASE $DRILL_DB"
DRILL_URL="${ADMIN_URL%/*}/$DRILL_DB"
trap 'psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null; rm -rf "$WORK"' EXIT
pg_restore --no-owner --no-privileges --dbname="$DRILL_URL" "$FILE"
FAIL=0
for t in users profiles contacts encounters relationships exchange_sessions guest_claims meetings consent_records audit_logs outbox_events schema_migrations; do
  a=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $t")
  b=$(psql "$DRILL_URL" -tAc "SELECT count(*) FROM $t")
  printf "%-20s source=%-6s restored=%-6s %s\n" "$t" "$a" "$b" "$([ "$a" = "$b" ] && echo OK || echo MISMATCH)"
  [ "$a" = "$b" ] || FAIL=1
done
echo "restore drill: $(( $(date +%s) - START ))s, $( [ $FAIL = 0 ] && echo PASSED || echo FAILED )"
exit $FAIL
