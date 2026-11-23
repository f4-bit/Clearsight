#!/bin/sh
set -e

echo "[startup] applying database migrations"
npm run prisma:deploy

if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  echo "[startup] bootstrapping administrator"
  set +e
  output="$(npm run admin:bootstrap 2>&1)"
  status=$?
  set -e
  if [ $status -ne 0 ]; then
    case "$output" in
      *BOOTSTRAP_ALREADY_INITIALIZED*)
        echo "[startup] administrator already exists; skipping bootstrap"
        ;;
      *)
        echo "$output" >&2
        exit 1
        ;;
    esac
  else
    echo "$output"
  fi
fi

echo "[startup] starting server"
exec npm start
