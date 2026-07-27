#!/bin/sh
# Container entrypoint: ensure DATA_DIR is writable, then exec Node as non-root
# so Docker's SIGTERM reaches the server process (not a shell wrapper).
set -eu

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Bind mounts created by the engine are often root-owned; fix for pwuser.
  chown -R pwuser:pwuser "$DATA_DIR" 2>/dev/null || true
  # Replace this process with Node under pwuser (uid 1000).
  exec setpriv --reuid=pwuser --regid=pwuser --init-groups \
    -- env HOME=/home/pwuser node dist/main.js
fi

exec node dist/main.js
