# Hooks and generated integrations

Septum can scaffold harness hooks and Git pre-commit checks through `init`. Generated files do not prove that a client has enabled the hooks or that the tool matcher covers the client's actual edits.

## Pre-write CLI

`septum hook pre-write` reads JSON from stdin and loads policy from `.septum/septum.db` in the workspace selected by `SEPTUM_HOOK_ROOT` or the caller’s current directory.

An absent database, empty input or invalid JSON passes through with exit code 0. A supported payload is reconstructed before import extraction. Unsupported payloads record `decision: "allow"` with `coverage: "unknown"` in telemetry and emit `{"decision": "ask"}` on stdout in non-quiet mode (or empty stdout in quiet harness modes).

| Payload content | Candidate interpretation |
| --- | --- |
| `CodeContent`, `content`, `Content` | Full proposed file, including an empty string |
| `old_string`/`TargetContent` plus replacement | Current source with replacement applied |
| `edits` or `ReplacementChunks` | Sequential replacements when old/new values are available |
| `command` containing `*** Begin Patch` (Codex `apply_patch`) | Per-file `Add` (`complete_candidate`) or `Update` (`replacement_fragment`) candidates |
| Replacement without old content | Replacement fragment |

- **Envelopes & paths:** Payload envelopes include `tool_input`, `arguments`, `toolCall.args`, and direct fields, with supported target path aliases. Containment checks run before existing-source reads.
- **Replacement matching:** `old_string` / `TargetContent` must be nonempty and match current source; multiple matches require `replace_all`. Missing or ambiguous matches fail.
- **Evaluation & exit codes:** For a nonempty candidate in a mapped source domain, the CLI parses candidate imports and runs `checkProposedChanges` (unsupported/degraded parsing of recognized source fails the check). Policy violations exit `1` (or `2` with `--exit-code-2`, `--claude`, `--cursor`, `--codex`, or `--opencode`). Default and `--exit-code-2` modes emit `{"decision": "deny", "reason": ...}` on stdout, while `--claude`, `--cursor`, `--codex`, and `--opencode` enable quiet stdout mode (suppressing stdout JSON and writing the reason to stderr only). Normalization/containment and AST/boundary evaluation errors use the same `blockHook` exit and output path.
- **Coverage & bypasses:** Successful candidates emit `coverage: "complete_candidate"` or `"replacement_fragment"` with an `evaluated` field. Empty candidates skip parsing, and unmapped source domains pass with `evaluated: "unmapped_domain"`.
- **Scope limits:** The hook checks candidate import policy only—not complete cycles, runtime effects, or the MCP boundary handler's full sync/freshness guards. Fragment coverage does not certify the reconstructed whole file, and arbitrary shell commands or free-form patches are outside this contract.

## Generated shell-wrapper behavior

The generated pre-write and post-write scripts run when `.septum/septum.db` exists. If it is absent, the wrapper exits 0. See [workspace lifecycle](workspace-lifecycle.md#upgrade-from-file-based-configuration) when upgrading an existing workspace.

Wrappers locate a runnable command through local Bun source, a `septum` executable, a local package binary or `bunx`. If no supported command is available, they can exit without performing a check.

## Post-write scheduling

Default harness configurations (`SEPTUM_HOOKS_CONFIG`) do not register `PostToolUse` because the MCP server `WorkspaceWatcher` handles incremental freshness in-process without per-edit shell lockfile contention. The generated `septum-post-write.sh` script remains available for CLI-only workflows: it changes to its workspace root, touches `.septum/sync.pending`, acquires `.septum/sync.lock` (with stale-PID recovery), and coalesces bursts in a background loop.

Scheduling is non-blocking and coalesces bursts. Sync stdout/stderr are redirected away; a successful wrapper exit does not prove the background sync succeeded. The sync command resolves configured policy/database after invocation, subject to the wrapper prerequisite above. Server watchers supply an independent freshness mechanism.

## Harness and Git integration

Scaffolding updates Septum-owned configuration while preserving supported unrelated hooks/settings. Behavior depends on the harness format, installed revision, tool matcher and enablement.

The generated Git pre-commit runs `septum check --staged`. Its blocking behavior follows effective CLI enforcement; warn mode can allow a commit after reporting violations. Existing unrelated Git hooks can be preserved rather than replaced. See [boundary behavior](septum-boundary.md) for frozen-index scope and exit codes.

## Implementation and regression evidence

- [Hook command](../../src/cli/commands/hook.ts), [payload normalization](../../src/cli/hook-payload.ts)
- [Generated wrappers/matchers](../../src/cli/templates/hooks.ts), [harness configuration](../../src/cli/scaffold/harness-config.ts)
- [Init/Git integration](../../src/cli/commands/init.ts)
- [Candidate reconstruction](../../tests/unit/refactor-contracts.test.ts), [SQLite CLI hook](../../tests/unit/policy-ownership.test.ts), [configuration preservation](../../tests/unit/init-hook-preservation.test.ts), [Codex integration harness](../../tests/integration/codex-hooks.py)

CLI regression tests are not evidence of live interception in every client.
