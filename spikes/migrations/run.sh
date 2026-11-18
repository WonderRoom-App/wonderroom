#!/bin/sh
# Run a Payload CLI command the way a container start would: no terminal on stdin and a
# 120-second limit. Exit 124 means the command hung (most likely on a prompt).
# Usage: WR_PLUGINS=typewriters,makers ./run.sh migrate:create init
set -u
cd "$(dirname "$0")"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5433/wr_spike}"
export WR_MIGRATIONS_DIR="${WR_MIGRATIONS_DIR:-$PWD/volume/migrations}"
export PAYLOAD_CONFIG_PATH="$PWD/payload.config.ts"
timeout 120 npx payload "$@" < /dev/null
echo "exit: $?"
