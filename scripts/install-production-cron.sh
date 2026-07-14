#!/usr/bin/env sh
set -eu

root="${NOTIFYHUB_ROOT:-/opt/notifyhub}"
current="${NOTIFYHUB_CURRENT:-/opt/notifyhub-current}"
cron_user="${NOTIFYHUB_CRON_USER:-runner}"
caller="$(id -un)"
id "$cron_user" > /dev/null 2>&1 || { echo "Cron account is missing: $cron_user" >&2; exit 77; }
if [ "$caller" != "$cron_user" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Cron must be installed by $cron_user or root" >&2
  exit 77
fi

cron() {
  if [ "$caller" = "$cron_user" ]; then crontab "$@"
  else crontab -u "$cron_user" "$@"
  fi
}

mkdir -p "$root/logs"
chmod 700 "$root/logs"
if [ "$(id -u)" -eq 0 ]; then chown "$cron_user:$cron_user" "$root/logs"; fi
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

cron -l 2>/dev/null \
  | sed '/^# BEGIN NOTIFYHUB$/,/^# END NOTIFYHUB$/d' \
  > "$temporary" || true
cat >> "$temporary" <<EOF
# BEGIN NOTIFYHUB
47 1 * * * flock -n $root/.cron-backup.lock $current/scripts/production-backup.sh >> $root/logs/backup.log 2>&1
17 2 * * * flock -n $root/.cron-retention.lock $current/scripts/production-maintenance.sh >> $root/logs/retention.log 2>&1
# END NOTIFYHUB
EOF
cron "$temporary"
