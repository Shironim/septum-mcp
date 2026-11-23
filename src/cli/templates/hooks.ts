export const SEPTUM_HOOKS_CONFIG = {
  "septum-boundary-guard": {
    "PreToolUse": [
      {
        "matcher": "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'ROOT=\"$(pwd -P)\"; for d in .gemini .claude .codex opencode .agents; do if [ -f \"$ROOT/$d/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/$d/hooks/septum-pre-write.sh\" \"$@\"; fi; done; exit 0'",
            "timeout": 10,
          },
        ],
      },
    ],
  },
};

export const SEPTUM_PRE_WRITE_SCRIPT = `#!/usr/bin/env sh
# Septum candidate import policy hook
# Passes supported edit payloads to the CLI before the client writes them

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

export SEPTUM_HOOK_ROOT="$ROOT_DIR"

# Invoke the available Septum CLI hook command
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
`;

export const SEPTUM_POST_WRITE_SCRIPT = `#!/usr/bin/env sh
# Septum Automated Incremental Post-Write Hook
# Syncs modified AST into SQLite SSOT after file mutations

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

# Sync always belongs to the workspace containing this generated wrapper.
cd "$ROOT_DIR" || exit 1
mkdir -p "$ROOT_DIR/.septum" 2>/dev/null || true

LOCK_DIR="$ROOT_DIR/.septum/sync.lock"
PENDING_FILE="$ROOT_DIR/.septum/sync.pending"

# Mark workspace as needing sync so an active lock holder coalesces burst edits
: > "$PENDING_FILE" 2>/dev/null || true

# Recover stale lock if holder PID is no longer alive
if [ -d "$LOCK_DIR" ] && [ -f "$LOCK_DIR/pid" ]; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
  if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
fi

# Non-blocking lock acquisition: if another background sync is active, exit 0
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi

run_septum_sync() {
  if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
    bun run "$ROOT_DIR/bin/septum.ts" sync >/dev/null 2>&1
  elif command -v septum >/dev/null 2>&1; then
    septum sync >/dev/null 2>&1
  elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
    "$ROOT_DIR/node_modules/.bin/septum" sync >/dev/null 2>&1
  elif command -v bunx >/dev/null 2>&1; then
    bunx septum sync >/dev/null 2>&1
  fi
}

# Trigger coalesced background incremental sync
(
  trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
  while [ -f "$PENDING_FILE" ]; do
    rm -f "$PENDING_FILE" 2>/dev/null || true
    run_septum_sync
  done
) >/dev/null 2>&1 &
echo "$!" > "$LOCK_DIR/pid" 2>/dev/null || true

exit 0
`;

