#!/usr/bin/env bash
# Strata-MCP Post-Write Delta Sync Hook
# Automatically updates SQLite graph cache when frontend files are modified.

set -e

FILE_PATH="$1"
if [ -z "$FILE_PATH" ] && [ -n "$CLAUDE_FILE_PATH" ]; then
  FILE_PATH="$CLAUDE_FILE_PATH"
fi

if [ -z "$FILE_PATH" ]; then
  if [ ! -t 0 ]; then
    STDIN_DATA="$(cat)"
    if [ -n "$STDIN_DATA" ]; then
      if command -v node >/dev/null 2>&1; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | node -e '
let raw = "";
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    const p = data?.tool_input?.file_path || data?.tool_input?.path || data?.file_path || data?.path || "";
    if (p) process.stdout.write(String(p));
  } catch {}
});
' 2>/dev/null || true)"
      elif command -v bun >/dev/null 2>&1; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | bun -e '
const raw = await Bun.stdin.text();
try {
  const data = JSON.parse(raw);
  const p = data?.tool_input?.file_path || data?.tool_input?.path || data?.file_path || data?.path || "";
  if (p) process.stdout.write(String(p));
} catch {}
' 2>/dev/null || true)"
      elif command -v python3 >/dev/null 2>&1; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get("tool_input", {}) if isinstance(d, dict) else {}
    p = ti.get("file_path") or ti.get("path") or d.get("file_path") or d.get("path") or ""
    if p: sys.stdout.write(str(p))
except Exception: pass
' 2>/dev/null || true)"
      fi

      if [ -z "$FILE_PATH" ]; then
        FILE_PATH="$(printf '%s' "$STDIN_DATA" | sed -n 's/.*"(file_path|path)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/p' | head -n 1)"
      fi
    fi
  fi
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Determine workspace root from the hook script location (.agents/hooks/..)
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="${STRATA_WORKSPACE_ROOT:-$(cd "$HOOK_DIR/../.." && pwd)}"

# Check if file has frontend extension
case "$FILE_PATH" in
  *.vue|*.astro|*.svelte|*.tsx|*.jsx|*.ts|*.js)
    if command -v strata >/dev/null 2>&1; then
      strata sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    elif command -v bun >/dev/null 2>&1 && [ -f "$WORKSPACE_ROOT/node_modules/.bin/strata" ]; then
      "$WORKSPACE_ROOT/node_modules/.bin/strata" sync "$WORKSPACE_ROOT" --json >/dev/null 2>&1 || true
    fi
    ;;
  *)
    # Not a frontend file, skip
    ;;
esac

exit 0
