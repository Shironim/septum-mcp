# Septum Hooks: Candidate Checks and Background Sync

## Pre-write

Generated hooks invoke `septum hook pre-write` with JSON on stdin. The command resolves policy and the configured database without creating an index. An absent database passes through.

`cli/hook-payload.ts` normalizes supported harness payloads:

| Input | Candidate |
| --- | --- |
| `content`, `Content`, `CodeContent` | Full proposed file, including an empty file |
| `old_string` + `new_string` | Current source with a unique replacement; `replace_all` permits multiple matches |
| `edits` / `ReplacementChunks` containing old/new text | Sequential replacements applied to current source |
| Replacement without old text | Replacement fragment |

Containment is checked before reading existing source. Missing or ambiguous replacement matches reject the check. The AST parser extracts candidate imports, which are evaluated against domain policy. Violations emit a JSON deny decision and exit nonzero: normally `1`, or `2` with the configured Claude/Cursor-style flag.

Allowed results describe their scope:

```json
{"decision":"allow","coverage":"complete_candidate","evaluated":"proposed_imports"}
```

`complete_candidate` describes reconstruction, not complete static/runtime enforcement. Fragment-only inputs report `replacement_fragment`. Inputs with no supported candidate report `coverage: "unknown"`; unmapped domains are identified separately. Arbitrary shell commands and free-form patches are outside this reconstruction contract.

Interception requires the client to enable the generated hooks and match the actual tool. Scaffolding is not evidence of active interception. Proposal checks do not certify existing imports or complete cycle freedom; use staged/codebase checks for those scopes.

## Post-write

The generated script marks `.septum/sync.pending`, obtains a directory lock and drains pending work in a detached sync loop. Bursts coalesce; stale-PID recovery is attempted. Scheduling markers remain under `.septum`, while `sync` resolves the configured database.

Scheduling is non-blocking for the client. Synchronization still takes time and can fail. Server watchers and query guards provide additional freshness checks.

## Harness and Git integration

`septum init` scaffolds selected integrations while preserving unrelated hooks. Payload and exit-code conventions vary by client; verify the active client after installation or upgrade.

Git pre-commit invokes `septum check --staged`, which uses a frozen index snapshot and includes unchanged source needed for resolution. See [boundary scope](septum-boundary.md).

## Regression evidence

`tests/unit/policy-ownership.test.ts` exercises the real custom-database CLI hook. `tests/unit/refactor-contracts.test.ts` covers candidate reconstruction. Scaffold tests cover configuration preservation; they do not certify all live client integrations.
