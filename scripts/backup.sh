#!/usr/bin/env bash
# F-184 logical backup (in addition to managed PITR). Usage: DATABASE_URL=... scripts/backup.sh [outdir]
set -euo pipefail
OUT="${1:-./backups}"
mkdir -p "$OUT"
FILE="$OUT/linkos-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$FILE"
sha256sum "$FILE" > "$FILE.sha256"
echo "$FILE"
