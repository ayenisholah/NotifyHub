#!/bin/sh
set -eu

role="${1:-}"

case "$role" in
  api)
    ./node_modules/.bin/prisma migrate deploy
    exec node packages/runtime/dist/main.js api
    ;;
  seed)
    exec node packages/runtime/dist/main.js seed
    ;;
  router|digest|email|sms|inapp)
    exec node packages/runtime/dist/main.js "$role"
    ;;
  demo)
    exec node packages/demo-host/dist-server/server.js
    ;;
  *)
    echo 'Expected container role: api, seed, router, digest, email, sms, inapp, or demo' >&2
    exit 64
    ;;
esac
