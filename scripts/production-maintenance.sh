#!/usr/bin/env sh
set -eu

root="${NOTIFYHUB_ROOT:-/opt/notifyhub}"
current="${NOTIFYHUB_CURRENT:-/opt/notifyhub-current}"
env_file="$root/.env"

docker compose --project-name notifyhub --project-directory "$current" \
  --env-file "$env_file" -f "$current/compose.yaml" \
  --profile maintenance run --rm retention
"$current/scripts/production-backup.sh" --prune-only
