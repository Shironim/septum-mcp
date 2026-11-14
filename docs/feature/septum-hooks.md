# Hooks and generated integrations

Septum can scaffold harness hooks and Git pre-commit checks through `init`. Generated files do not prove that a client has enabled the hooks or that the tool matcher covers the client's actual edits.

## Pre-write CLI

`septum hook pre-write` reads JSON from stdin. It resolves policy and the configured database from the workspace selected by `SEPTUM_HOOK_ROOT` or the caller's current directory.

An absent database, empty input or invalid JSON passes through with exit code 0. A supported payload is reconstructed before import extraction. Unsupported payloads emit an allow decision with `coverage: "unknown"`.

| Payload content | Candidate interpretation |
| --- | --- |
| `CodeContent`, `content`, `Content` | Full proposed file, including an empty string |
| `old_string`/`TargetContent` plus replacement | Current source with replacement applied |
| `edits` or `ReplacementChunks` | Sequential replacements when old/new values are available |
| Replacement without old content | Replacement fragment |

Payload envelopes include `tool_input`, `arguments`, `toolCall.args` and direct fields. Targets accept supported path aliases. Replacement old text must be nonempty and match current source; multiple matches require `replace_all`. Missing or ambiguous matches fail. Containment checks precede existing-source reads.

For a nonempty candidate in a mapped source domain, the CLI parses candidate imports and runs `checkProposedChanges`. Unsupported/degraded parsing of recognized source fails the check. A policy violation emits `decision: "deny"` and exits 1, or 2 with `--exit-code-2`, `--claude` or `--cursor`. Other processing errors exit nonzero but do not necessarily emit the same deny JSON.

Successful candidates emit `coverage: "complete_candidate"` or `"replacement_fragment"` and an `evaluated` field. Empty candidates skip parsing. Unmapped source domains pass with `evaluated: "unmapped_domain"`; they are not blocked by this hook path.

The hook checks candidate import policy, not complete cycles or runtime effects. It does not use the MCP boundary handler's full sync/freshness guards. Fragment coverage does not certify the reconstructed whole file. Arbitrary shell commands and free-form patch formats are outside this candidate reconstruction contract.

## Generated shell-wrapper limitation

The generated pre-write and post-write scripts first check for `.septum/septum.db`. If only a custom database exists, the wrapper exits before invoking the CLI. Direct `septum hook pre-write` honors configured `db_path`, but that does not remove this wrapper prerequisite.

Wrappers locate a runnable command through local Bun source, a `septum` executable, a local package binary or `bunx`. If no supported command is available, they can exit without performing a check.

## Post-write scheduling

The generated post-write wrapper changes to its workspace root, touches `.septum/sync.pending` and attempts to acquire a directory lock at `.septum/sync.lock`. It attempts stale-PID lock recovery. A background loop removes pending markers and invokes sync until no marker remains.

Scheduling is non-blocking and coalesces bursts. Sync stdout/stderr are redirected away; a successful wrapper exit does not prove the background sync succeeded. The sync command resolves configured policy/database after invocation, subject to the wrapper prerequisite above. Server watchers supply an independent freshness mechanism.

## Harness and Git integration

Scaffolding updates Septum-owned configuration while preserving supported unrelated hooks/settings. Behavior depends on the harness format, installed revision, tool matcher and enablement.

The generated Git pre-commit runs `septum check --staged`. Its blocking behavior follows effective CLI enforcement; warn mode can allow a commit after reporting violations. Existing unrelated Git hooks can be preserved rather than replaced. See [boundary behavior](septum-boundary.md) for frozen-index scope and exit codes.

## Implementation and regression evidence

- [Hook command](../../src/cli/commands/hook.ts), [payload normalization](../../src/cli/hook-payload.ts)
- [Generated wrappers/matchers](../../src/cli/templates/hooks.ts), [harness configuration](../../src/cli/scaffold/harness-config.ts)
- [Init/Git integration](../../src/cli/commands/init.ts)
- [Candidate reconstruction](../../tests/unit/refactor-contracts.test.ts), [custom database CLI hook](../../tests/unit/policy-ownership.test.ts), [configuration preservation](../../tests/unit/init-hook-preservation.test.ts), [Codex integration harness](../../tests/integration/codex-hooks.py)

CLI regression tests are not evidence of live interception in every client.
