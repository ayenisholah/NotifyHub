#!/usr/bin/env sh
set -eu

umask 077

root="${NOTIFYHUB_ROOT:-/opt/notifyhub}"
current="${NOTIFYHUB_CURRENT:-/opt/notifyhub-current}"
backup_root="${NOTIFYHUB_BACKUP_ROOT:-$root/backups}"
env_file="$root/.env"
lock_file="$root/.backup.lock"

case "$root:$current:$backup_root" in
  /*:/*:/*) ;;
  *) echo 'Production paths must be absolute' >&2; exit 64 ;;
esac

mkdir -p "$backup_root"
chmod 700 "$backup_root"
exec 9>"$lock_file"
flock -n 9 || { echo 'Another backup or cleanup is already running' >&2; exit 75; }

prune_backups() {
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -rn \
    | awk 'NR > 30 { sub(/^[^ ]+ /, ""); print }' \
    | while IFS= read -r expired; do
        case "$expired" in "$backup_root"/*) rm -rf -- "$expired" ;; *) exit 70 ;; esac
      done
}

if [ "${1:-}" = '--prune-only' ]; then
  prune_backups
  exit 0
fi

[ -f "$current/compose.yaml" ] || { echo "Missing current release at $current" >&2; exit 66; }
[ -f "$env_file" ] || { echo "Missing production environment file at $env_file" >&2; exit 66; }
[ "$(stat -c '%a' "$env_file")" = '600' ] || { echo "$env_file must have mode 600" >&2; exit 77; }

compose() {
  docker compose --project-name notifyhub --project-directory "$current" \
    --env-file "$env_file" -f "$current/compose.yaml" "$@"
}

postgres_id="$(compose ps --status running -q postgres)"
[ -n "$postgres_id" ] || { echo 'PostgreSQL is not running; refusing an incomplete backup' >&2; exit 69; }

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
revision="$(basename "$(readlink -f "$current")")"
case "$revision" in *[!0-9a-f]*|'') revision='unknown' ;; esac
destination="$backup_root/$timestamp-$revision"
mkdir "$destination"
chmod 700 "$destination"

cleanup_incomplete() {
  if [ ! -f "$destination/COMPLETE" ]; then rm -rf -- "$destination"; fi
}
trap cleanup_incomplete EXIT HUP INT TERM

compose exec -T postgres sh -eu -c \
  'pg_dump -p 4132 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  > "$destination/postgresql.dump"
compose exec -T postgres pg_restore --list < "$destination/postgresql.dump" > /dev/null

cp "$env_file" "$destination/environment.env"
chmod 600 "$destination/environment.env"
compose config > "$destination/compose.resolved.yaml"
chmod 600 "$destination/compose.resolved.yaml"

cat > "$destination/manifest.json" <<EOF
{"createdAt":"$timestamp","revision":"$revision","format":"postgresql-custom","databaseRestore":"manual"}
EOF
chmod 600 "$destination/manifest.json"
(
  cd "$destination"
  sha256sum postgresql.dump environment.env compose.resolved.yaml manifest.json > SHA256SUMS
)
chmod 600 "$destination/SHA256SUMS"
touch "$destination/COMPLETE"
chmod 600 "$destination/COMPLETE"
trap - EXIT HUP INT TERM

prune_backups
printf '%s\n' "$destination"
