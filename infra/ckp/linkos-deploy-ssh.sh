#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (docs/DEPLOY_CKP.md "자동 배포").
# In /root/.ssh/authorized_keys:
#   restrict,command="/usr/local/bin/linkos-deploy-ssh" ssh-ed25519 AAAA... github-actions-linkos
# The key can then do exactly one thing: run scripts/deploy-ckp.sh for a validated ref — no shell,
# no port forwarding, no other commands.
set -euo pipefail
cmd="${SSH_ORIGINAL_COMMAND:-}"
# accepted: bash /var/www/linkos/scripts/deploy-ckp.sh '<ref>'
ref="$(printf '%s' "$cmd" | sed -n "s#^bash /var/www/linkos/scripts/deploy-ckp\.sh '\([A-Za-z0-9._/-]\{1,100\}\)'\$#\1#p")"
if [ -z "$ref" ]; then
  echo "linkos-deploy-ssh: refused command" >&2
  logger -t linkos-deploy "refused: ${cmd:0:120}" 2>/dev/null || true
  exit 1
fi
logger -t linkos-deploy "deploy requested: $ref" 2>/dev/null || true
exec bash /var/www/linkos/scripts/deploy-ckp.sh "$ref"
