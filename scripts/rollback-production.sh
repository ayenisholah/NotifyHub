#!/usr/bin/env sh
set -eu

revision="${1:-}"
case "$revision" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo 'Rollback requires an exact 40-character lowercase SHA' >&2; exit 64 ;;
esac

root="${NOTIFYHUB_ROOT:-/opt/notifyhub}"
current="${NOTIFYHUB_CURRENT:-/opt/notifyhub-current}"
state="$root/deployments/$revision.previous"
env_file="$root/.env"
lock_file="$root/.deploy.lock"
exec 9>"$lock_file"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 75; }

[ "$(basename "$(readlink -f "$current")")" = "$revision" ] || {
  echo 'Refusing to roll back a release that is not current' >&2; exit 65;
}
[ -s "$state" ] || { echo "No previous release is recorded for $revision" >&2; exit 66; }
previous="$(cat "$state")"
[ -f "$previous/compose.yaml" ] || { echo 'Recorded previous release is unavailable' >&2; exit 66; }
[ -f "$root/.env.before-$revision" ] || { echo 'Previous environment snapshot is unavailable' >&2; exit 66; }

temporary_link="$root/.current-rollback-$revision"
ln -s "$previous" "$temporary_link"
mv -Tf "$temporary_link" "$current"
cp "$root/.env.before-$revision" "$env_file"
chmod 600 "$env_file"
docker compose --project-name notifyhub --project-directory "$previous" \
  --env-file "$env_file" -f "$previous/compose.yaml" up --detach --wait --wait-timeout 180
curl --fail --silent --show-error http://127.0.0.1:4100/ > /dev/null
curl --fail --silent --show-error http://127.0.0.1:4101/readyz > /dev/null
runtime_user="${NOTIFYHUB_RUNTIME_USER:-runner}"
if [ "$(id -u)" -eq 0 ] && id "$runtime_user" > /dev/null 2>&1; then
  chown -R "$runtime_user:$runtime_user" "$root"
  chown -h "$runtime_user:$runtime_user" "$current"
fi
printf 'Rolled back %s to %s; database restoration was not performed.\n' "$revision" "$(basename "$previous")"
