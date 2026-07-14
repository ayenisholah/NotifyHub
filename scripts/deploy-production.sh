#!/usr/bin/env sh
set -eu

revision="${1:-}"
case "$revision" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo 'Deployment requires the exact successful 40-character lowercase main SHA' >&2; exit 64 ;;
esac

root="${NOTIFYHUB_ROOT:-/opt/notifyhub}"
current="${NOTIFYHUB_CURRENT:-/opt/notifyhub-current}"
release="$root/releases/$revision"
env_file="$root/.env"
expected_user="${NOTIFYHUB_DEPLOY_USER:-runner}"
runtime_user="${NOTIFYHUB_RUNTIME_USER:-runner}"
[ "$(id -un)" = "$expected_user" ] || { echo "Deployment must run as $expected_user" >&2; exit 77; }
id "$runtime_user" > /dev/null 2>&1 || { echo "Runtime account is missing: $runtime_user" >&2; exit 77; }
[ -f "$release/compose.yaml" ] || { echo "Release payload is missing for $revision" >&2; exit 66; }
[ -f "$env_file" ] || { echo "Missing $env_file" >&2; exit 66; }
[ "$(stat -c '%a' "$env_file")" = '600' ] || { echo "$env_file must have mode 600" >&2; exit 77; }

mkdir -p "$root/releases" "$root/deployments" "$root/backups"
chmod 700 "$root" "$root/releases" "$root/deployments" "$root/backups"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 75; }

candidate_compose() {
  env NOTIFYHUB_IMAGE_TAG="$revision" NOTIFYHUB_REVISION="$revision" \
    docker compose --project-name notifyhub --project-directory "$release" \
      --env-file "$env_file" -f "$release/compose.yaml" "$@"
}

candidate_compose config --quiet
candidate_compose build --build-arg "VCS_REF=$revision"
image_revision="$(docker image inspect "notifyhub:$revision" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[ "$image_revision" = "$revision" ] || { echo 'Candidate image revision label mismatch' >&2; exit 65; }

previous=''
if [ -L "$current" ] && [ -f "$current/compose.yaml" ]; then
  previous="$(readlink -f "$current")"
  NOTIFYHUB_CURRENT="$current" "$release/scripts/production-backup.sh" \
    > "$root/deployments/$revision.backup"
fi
printf '%s\n' "$previous" > "$root/deployments/$revision.previous"
cp "$env_file" "$root/.env.before-$revision"
chmod 600 "$root/.env.before-$revision"

set_release_env() {
  key="$1"
  value="$2"
  temporary="$root/.env.update-$revision"
  grep -v "^$key=" "$env_file" > "$temporary" || true
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$env_file"
}
set_release_env NOTIFYHUB_IMAGE_TAG "$revision"
set_release_env NOTIFYHUB_REVISION "$revision"

temporary_link="$root/.current-$revision"
ln -s "$release" "$temporary_link"
mv -Tf "$temporary_link" "$current"

rollback_on_failure() {
  status="$?"
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    cp "$root/.env.before-$revision" "$env_file"
    chmod 600 "$env_file"
    if [ -n "$previous" ] && [ -f "$previous/compose.yaml" ]; then
      rollback_link="$root/.current-failed-$revision"
      ln -s "$previous" "$rollback_link"
      mv -Tf "$rollback_link" "$current"
      docker compose --project-name notifyhub --project-directory "$previous" \
        --env-file "$env_file" -f "$previous/compose.yaml" up --detach --wait --wait-timeout 180 || true
    else
      candidate_compose down || true
      rm -f "$current"
    fi
  fi
  exit "$status"
}
trap rollback_on_failure EXIT HUP INT TERM

candidate_compose up --detach --wait --wait-timeout 180
for service in api worker-router worker-digest worker-email worker-sms worker-inapp demo; do
  container="$(candidate_compose ps -q "$service")"
  [ -n "$container" ] || { echo "Missing application container: $service" >&2; exit 69; }
  running_image="$(docker inspect "$container" --format '{{.Config.Image}}')"
  [ "$running_image" = "notifyhub:$revision" ] || { echo "$service is running $running_image" >&2; exit 65; }
done
curl --fail --silent --show-error http://127.0.0.1:4100/ > /dev/null
curl --fail --silent --show-error http://127.0.0.1:4101/readyz > /dev/null
curl --fail --silent --show-error http://127.0.0.1:4125/readyz > /dev/null
chown -R "$runtime_user:$runtime_user" "$root"
chown -h "$runtime_user:$runtime_user" "$current"
NOTIFYHUB_CRON_USER="$runtime_user" "$release/scripts/install-production-cron.sh"

trap - EXIT HUP INT TERM

find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn \
  | awk 'NR > 3 { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r expired; do
      [ "$expired" = "$(readlink -f "$current")" ] || rm -rf -- "$expired"
    done
keep_revisions="$(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')"
docker image ls notifyhub --format '{{.Tag}}' \
  | grep -E '^[0-9a-f]{40}$' \
  | while IFS= read -r tag; do
      printf '%s\n' "$keep_revisions" | grep -qx "$tag" || docker image rm "notifyhub:$tag" || true
    done

printf 'Deployed immutable release %s; previous release: %s\n' "$revision" "${previous:-none}"
