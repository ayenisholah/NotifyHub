#!/usr/bin/env sh
set -eu

root="${NOTIFYHUB_ROOT:-/opt/notifyhub}"
current="${NOTIFYHUB_CURRENT:-/opt/notifyhub-current}"
expected_user="${NOTIFYHUB_DEPLOY_USER:-runner}"
[ "$(id -un)" = "$expected_user" ] || { echo "Cron must be installed by $expected_user" >&2; exit 77; }

mkdir -p "$root/logs"
chmod 700 "$root/logs"
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

crontab -l 2>/dev/null \
  | sed '/^# BEGIN NOTIFYHUB$/,/^# END NOTIFYHUB$/d' \
  > "$temporary" || true
cat >> "$temporary" <<EOF
# BEGIN NOTIFYHUB
47 1 * * * flock -n $root/.cron-backup.lock $current/scripts/production-backup.sh >> $root/logs/backup.log 2>&1
17 2 * * * flock -n $root/.cron-retention.lock $current/scripts/production-maintenance.sh >> $root/logs/retention.log 2>&1
# END NOTIFYHUB
EOF
crontab "$temporary"
