#!/usr/bin/env bash
# F-186 재해복구 — logical backup + manifest, copied to a PRIMARY and a CROSS-REGION SECONDARY location.
# Complements managed PITR (RPO ≈ minutes); this job bounds RPO to the schedule interval even if the provider region is lost.
#
# Usage:
#   DATABASE_URL=postgres://...  DR_PRIMARY=s3://linkos-backups-apne2/db  DR_SECONDARY=s3://linkos-backups-usw2/db  scripts/dr/dr-backup-copy.sh
# Locations: s3://… (aws cli), gs://… (gsutil), or a local/mounted directory (file:///path or /path) for drills.
# Optional: DR_RETENTION_DAYS (default 35) prunes local-directory copies; object stores should use lifecycle rules instead.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}" "${DR_PRIMARY:?DR_PRIMARY is required}" "${DR_SECONDARY:?DR_SECONDARY is required}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FILE="$("$HERE/../backup.sh" "$WORK")"
BASE="$(basename "$FILE")"
SHA="$(cut -d' ' -f1 "$FILE.sha256")"

# manifest: what a restore must reproduce (verified by dr-restore-verify.sh without access to the primary DB)
TABLES="users profiles contacts encounters relationships exchange_sessions guest_claims meetings consent_records audit_logs subscriptions"
{
  printf '{"file":"%s","sha256":"%s","created_at":"%s","source":"%s","counts":{' "$BASE" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)"
  first=1
  for t in $TABLES; do
    if n=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $t" 2>/dev/null); then
      [ $first = 1 ] || printf ','
      printf '"%s":%s' "$t" "$n"
      first=0
    fi
  done
  printf '},"migrations":"%s"}\n' "$(psql "$DATABASE_URL" -tAc "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")"
} > "$WORK/$BASE.manifest.json"

put() { # put <local file> <location>
  case "$2" in
    s3://*) aws s3 cp --only-show-errors "$1" "$2/$(basename "$1")" ;;
    gs://*) gsutil -q cp "$1" "$2/$(basename "$1")" ;;
    *) dir="${2#file://}"; mkdir -p "$dir"; cp "$1" "$dir/" ;;
  esac
}

for loc in "$DR_PRIMARY" "$DR_SECONDARY"; do
  for f in "$FILE" "$FILE.sha256" "$WORK/$BASE.manifest.json"; do put "$f" "$loc"; done
  # LATEST pointer is written last so a reader never sees a half-copied set
  echo "$BASE" > "$WORK/LATEST"
  put "$WORK/LATEST" "$loc"
done

for loc in "$DR_PRIMARY" "$DR_SECONDARY"; do
  case "$loc" in
    s3://* | gs://*) ;;
    *) find "${loc#file://}" -name 'linkos-*.dump*' -mtime +"${DR_RETENTION_DAYS:-35}" -delete 2>/dev/null || true ;;
  esac
done
echo "dr-backup: $BASE sha256=$SHA → $DR_PRIMARY , $DR_SECONDARY"
