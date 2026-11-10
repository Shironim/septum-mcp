#!/usr/bin/env sh
# Septum 3-Gate Boundary Guard Pre-Write Hook
# Intercepts write_to_file and replace_file_content before disk mutation

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

export SEPTUM_HOOK_ROOT="$ROOT_DIR"

# Delegate directly to Septum's active 3-gate hook engine
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
  exec bun run "$ROOT_DIR/bin/septum.ts" hook pre-write "$@"
elif command -v septum >/dev/null 2>&1; then
  exec septum hook pre-write "$@"
elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
  exec "$ROOT_DIR/node_modules/.bin/septum" hook pre-write "$@"
elif command -v bunx >/dev/null 2>&1; then
  exec bunx septum hook pre-write "$@"
fi

exit 0
