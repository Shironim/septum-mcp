#!/usr/bin/env sh
# Septum Automated Incremental Post-Write Hook
# Syncs modified AST into SQLite SSOT after file mutations

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

# Sync always belongs to the workspace containing this generated wrapper.
cd "$ROOT_DIR" || exit 1

# Trigger background incremental sync
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
  bun run "$ROOT_DIR/bin/septum.ts" sync >/dev/null 2>&1 &
elif command -v septum >/dev/null 2>&1; then
  septum sync >/dev/null 2>&1 &
elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
  "$ROOT_DIR/node_modules/.bin/septum" sync >/dev/null 2>&1 &
elif command -v bunx >/dev/null 2>&1; then
  bunx septum sync >/dev/null 2>&1 &
fi

exit 0
