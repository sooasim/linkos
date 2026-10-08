#!/usr/bin/env bash
# F-186 재해복구 — restore the LATEST backup from the cross-region SECONDARY into a scratch database and verify it
# WITHOUT touching the primary database (assume the primary region is gone).
# Checks: checksum, pg_restore success, schema_migrations == manifest, row counts == manifest, app smoke queries.
# Reports measured RTO (restore wall time) and RPO (age of the backup). Exit 1 on any failure.
#
# Usage:
#   ADMIN_URL=postgres://user:pass@dr-host:5432/postgres DR_SOURCE=s3://linkos-backups-usw2/db scripts/dr/dr-restore-verify.sh
#   KEEP_DB=1 keeps the restored database (promotion path in RUNBOOK.md); RPO_MAX_MIN / RTO_MAX_MIN set pass thresholds.
set -euo pipefail
: "${ADMIN_URL:?ADMIN_URL is required}" "${DR_SOURCE:?DR_SOURCE is required}"
RPO_MAX_MIN="${RPO_MAX_MIN:-1500}" # daily job + slack
RTO_MAX_MIN="${RTO_MAX_MIN:-60}"
WORK="$(mktemp -d)"
DRILL_DB="linkos_dr_$(date +%s)"
DRILL_URL="${ADMIN_URL%/*}/$DRILL_DB"
cleanup() {
  rm -rf "$WORK"
  [ "${KEEP_DB:-0}" = 1 ] || psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

get() { # get <name> → $WORK/<name>
  case "$DR_SOURCE" in
    s3://*) aws s3 cp --only-show-errors "$DR_SOURCE/$1" "$WORK/$1" ;;
    gs://*) gsutil -q cp "$DR_SOURCE/$1" "$WORK/$1" ;;
    *) cp "${DR_SOURCE#file://}/$1" "$WORK/$1" ;;
  esac
}

START=$(date +%s)
get LATEST
BASE="$(tr -d '[:space:]' < "$WORK/LATEST")"
get "$BASE"
get "$BASE.sha256"
get "$BASE.manifest.json"
[ "$(sha256sum "$WORK/$BASE" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$WORK/$BASE.sha256")" ] || { echo "FAIL checksum mismatch for $BASE"; exit 1; }

psql "$ADMIN_URL" -qc "CREATE DATABASE $DRILL_DB"
if ! pg_restore --no-owner --no-privileges --dbname="$DRILL_URL" "$WORK/$BASE" 2> "$WORK/restore.log"; then
  # non-superuser restores may only fail on extension comments/ownership; anything else is a real failure
  if grep -E '^pg_restore: error:' "$WORK/restore.log" | grep -v -E 'must be owner of extension|COMMENT ON EXTENSION' | grep -q -v 'errors ignored on restore'; then
    cat "$WORK/restore.log"
    echo "FAIL pg_restore"
    exit 1
  fi
fi
RTO_SEC=$(( $(date +%s) - START ))

FAIL=0
MANIFEST="$WORK/$BASE.manifest.json"
want_mig="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).migrations)' "$MANIFEST")"
got_mig="$(psql "$DRILL_URL" -tAc "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")"
if [ "$want_mig" = "$got_mig" ]; then echo "OK   schema_migrations ($want_mig)"; else echo "FAIL schema_migrations want=$want_mig got=$got_mig"; FAIL=1; fi

while IFS='=' read -r t n; do
  got=$(psql "$DRILL_URL" -tAc "SELECT count(*) FROM $t")
  if [ "$got" = "$n" ]; then printf "OK   %-20s %s\n" "$t" "$n"; else printf "FAIL %-20s manifest=%s restored=%s\n" "$t" "$n" "$got"; FAIL=1; fi
done < <(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const [k,v] of Object.entries(m.counts))console.log(k+"="+v)' "$MANIFEST")

# smoke: the queries the guest landing / home screen depend on must plan and run
for sql in \
  "SELECT count(*) FROM exchange_sessions WHERE token_hash IS NOT NULL" \
  "SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND merged_into_id IS NULL" \
  "SELECT count(*) FROM outbox_events WHERE published_at IS NULL"; do
  psql "$DRILL_URL" -tAc "$sql" >/dev/null || { echo "FAIL smoke: $sql"; FAIL=1; }
done

CREATED="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).created_at)' "$MANIFEST")"
RPO_MIN=$(( ( $(date +%s) - $(date -d "$CREATED" +%s) ) / 60 ))
[ "$RPO_MIN" -le "$RPO_MAX_MIN" ] || { echo "FAIL RPO ${RPO_MIN}m > ${RPO_MAX_MIN}m (backup too old)"; FAIL=1; }
[ $(( RTO_SEC / 60 )) -le "$RTO_MAX_MIN" ] || { echo "FAIL RTO ${RTO_SEC}s > ${RTO_MAX_MIN}m"; FAIL=1; }
echo "dr-restore-verify: backup=$BASE rpo=${RPO_MIN}m rto=${RTO_SEC}s db=$DRILL_DB$([ "${KEEP_DB:-0}" = 1 ] && echo " (kept)") → $([ $FAIL = 0 ] && echo PASSED || echo FAILED)"
exit $FAIL
