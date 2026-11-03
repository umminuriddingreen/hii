#!/bin/sh
# One-shot native HII backup; launchd owns repetition, not a second daemon.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export HII_ROOT="$ROOT"
export HII_RUNTIME_DIR="${HII_RUNTIME_DIR:-$HOME/.hii}"
export HII_DB_PATH="${HII_DB_PATH:-$HII_RUNTIME_DIR/hii.db}"
exec "$ROOT/target/debug/hii" session-backup run
