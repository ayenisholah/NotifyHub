#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
reliability_run_url=${MEASUREMENT_RELIABILITY_RUN_URL:-${1:-}}
production_health_url=${MEASUREMENT_PRODUCTION_HEALTH_URL:-https://notifyhub.sholaayeni.xyz/}

if [ -z "$reliability_run_url" ]; then
  echo 'Usage: MEASUREMENT_RELIABILITY_RUN_URL=https://github.com/OWNER/REPO/actions/runs/ID scripts/measure.sh' >&2
  exit 64
fi

commit_sha=$(git -C "$root" rev-parse HEAD)
short_sha=$(git -C "$root" rev-parse --short HEAD)
stamp=$(date -u +%Y%m%dt%H%M%Sz)
project="notifyhub-measurement-$short_sha"
image_tag="measurement-$short_sha"
run_prefix="$stamp-$short_sha"
calibration_directory=${TMPDIR:-/tmp}/notifyhub-calibration-$run_prefix

mkdir -p "$calibration_directory" "$root/docs/evidence"

export POSTGRES_DB=notifyhub_measurement
export POSTGRES_USER=notifyhub_measurement
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(openssl rand -hex 32)
export API_KEY
API_KEY=$(openssl rand -hex 32)
export OPERATOR_KEY
OPERATOR_KEY=$(openssl rand -hex 32)
export TOKEN_SECRET
TOKEN_SECRET=$(openssl rand -hex 32)
export DEMO_USER_ID=measurement-demo-user
export WS_ALLOWED_ORIGINS=http://127.0.0.1:4200
export EMAIL_PROVIDER=mailpit
export EMAIL_FROM='NotifyHub Measurement <notifyhub@measurement.example.test>'
export SMS_PROVIDER=mock
export MOCK_SMS_FAILURE_RATE=0.05
export LOG_LEVEL=warn
export NOTIFYHUB_IMAGE_TAG=$image_tag
export NOTIFYHUB_API_PORT=4201
export NOTIFYHUB_DEMO_PORT=4200
export NOTIFYHUB_MAILPIT_UI_PORT=4225

compose() {
  docker compose --project-name "$project" --project-directory "$root" -f "$root/compose.yaml" "$@"
}

started=false
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$started" = true ]; then
    compose logs --no-color --tail 200 >&2 || true
  fi
  if [ "$started" = true ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$calibration_directory"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

compose build
compose up --detach --wait --wait-timeout 180 \
  api worker-router worker-digest worker-email worker-sms worker-inapp
started=true

selected_rate=
for rate in 25 50 100 200; do
  run_id="$run_prefix-cal-$rate"
  echo "Calibrating at $rate notifications/second..."
  if compose run --rm --no-deps \
    --user "$(id -u):$(id -g)" \
    --volume "$calibration_directory:/evidence" \
    --env MEASUREMENT_RUN_ID="$run_id" \
    --env MEASUREMENT_KIND=calibration \
    --env MEASUREMENT_COMMIT_SHA="$commit_sha" \
    --env MEASUREMENT_NOTIFICATION_COUNT=250 \
    --env MEASUREMENT_USER_COUNT=20 \
    --env MEASUREMENT_RATE_PER_SECOND="$rate" \
    --env MEASUREMENT_CONCURRENCY=25 \
    --env MEASUREMENT_TIMEOUT_SECONDS=300 \
    api measure
  then
    selected_rate=$rate
  else
    break
  fi
done

if [ -z "$selected_rate" ]; then
  echo 'No calibration rate met the acceptance criteria.' >&2
  exit 1
fi

run_id="$run_prefix-10k"
echo "Running 10,000-notification measurement at $selected_rate notifications/second..."
compose run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  --volume "$root/docs:/docs" \
  --env MEASUREMENT_RUN_ID="$run_id" \
  --env MEASUREMENT_KIND=measured \
  --env MEASUREMENT_COMMIT_SHA="$commit_sha" \
  --env MEASUREMENT_NOTIFICATION_COUNT=10000 \
  --env MEASUREMENT_USER_COUNT=100 \
  --env MEASUREMENT_RATE_PER_SECOND="$selected_rate" \
  --env MEASUREMENT_CONCURRENCY=50 \
  --env MEASUREMENT_TIMEOUT_SECONDS=900 \
  --env MEASUREMENT_OUTPUT_DIRECTORY=/docs/evidence \
  --env MEASUREMENT_REPORT_PATH=/docs/measurements.md \
  --env MEASUREMENT_RELIABILITY_RUN_URL="$reliability_run_url" \
  --env MEASUREMENT_PRODUCTION_HEALTH_URL="$production_health_url" \
  api measure

evidence_file="$root/docs/evidence/$run_id.json"
if grep -E \
  '(postgres(ql)?|redis(s)?):\/\/|Bearer |API_KEY|OPERATOR_KEY|TOKEN_SECRET|DATABASE_URL|REDIS_URL|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' \
  "$evidence_file" "$root/docs/measurements.md"
then
  echo 'Evidence contains a credential, connection string, or private delivery identifier.' >&2
  exit 1
fi

echo "Measurement passed: docs/evidence/$run_id.json"
