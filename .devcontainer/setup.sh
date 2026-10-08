#!/usr/bin/env bash
# Runs once when the codespace is created: install dependencies and build the web app.
set -euo pipefail
cd "$(dirname "$0")/.."
sudo corepack enable >/dev/null 2>&1 || corepack enable
corepack prepare pnpm@10.28.0 --activate >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
NEXT_TELEMETRY_DISABLED=1 pnpm build
git rev-parse HEAD > apps/web/.next/BUILT_FROM 2>/dev/null || true
