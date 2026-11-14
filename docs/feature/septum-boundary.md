# septum_boundary and CLI checks

Boundary analysis applies configured domain rules to statically resolved imports and detects selected domain/file cycles. Approval concerns the analyzed static scope; it does not certify runtime behavior or complete language resolution.

## Rules actually implemented

| Rule | Trigger |
| --- | --- |
| `forbidden_dependency` | Resolved target domain occurs in the source domain's forbidden list |
| `disallowed_dependency` | In strict mode, a cross-domain target is absent from the source domain's allowed list |
| `circular_dependency` | DFS finds a cycle in the constructed domain or file import graph |
| `unmapped_domain` | Proposal evaluation has a source file with no registered domain |

Forbidden checks apply in both warn and strict modes. Same-domain imports do not require allowlist membership. Cycle analysis excludes recognized type-only imports; domain-cycle construction also excludes the virtual `root` aggregator. These are graph checks over available resolved evidence, not a proof of all runtime cycles.

**Current unmapped-target limitation:** `unmapped_domain` does not mean “target is outside all domains.” The evaluator skips a target whose domain cannot be resolved. A proposal from a mapped source to a real internal file outside all domain roots can receive `approved`, including in strict mode. Other incomplete-resolution guards can return unknown, but they do not implement a universal unmapped-target rejection.

Domain policies match domain names, not directory categories. See [map](septum-map.md) for the current Go discovery naming limitation.

Boundary decisions use the [language resolver](import-resolution.md), not the extractor's `is_external` flag alone. The new Rust/Ruby/Java/C# paths can resolve supported local targets; missing classpaths, dynamic configuration and conditional imports still yield incomplete evidence. A repository with no relevant imports can be approved even when some language constructs are unsupported.

## MCP scopes

```json
{"scope":"file","file_path":"src/orders/service.ts","proposed_imports":["../billing/service"]}
```

File scope evaluates supplied candidate imports and simulated cycles using available indexed relationships. `file_paths` supports multiple sources. Use either `file_path` or `file_paths`, not both.

The response records proposal scope and `existing_imports_checked: false` where supplied. Omitting imports or supplying an empty list does not audit the existing file. Proposal success must not be interpreted as an existing-file clean bill. Freshness/incomplete-evidence guards can also surface known existing violations before proposal evaluation.

```json
{"scope":"all"}
```

All scope audits the indexed dependency graph. `{"scope":"domain","domain":"orders"}` narrows analysis to a registered domain. Unknown domain names are rejected. Without explicit scope, a file target selects file scope, a domain selects domain scope, otherwise the default is all.

```json
{"scope":"staged"}
```

Staged scope freezes the Git index using `git write-tree`. Source and interpretation files are materialized from the resulting tree, including unchanged source needed for import/cycle resolution. Unstaged source does not replace staged bytes. Manifest/interpretation changes can widen the affected scope.

Staged analysis rejects snapshots containing symlinks or submodules. Snapshot entry-count, source-size and total-source-byte limits apply. Non-source binary entries are inventoried without materializing their contents or applying the source-size cap. Unmapped source files are skipped by the staged source loop; staged approval does not establish domain ownership for every file.

## Completeness and statuses

The MCP handler requires completed workspace synchronization. Missing/running/error sync, relevant skipped files or unsupported sources can return `unknown`. Stale sources and incomplete import relationships produce diagnostics; known violations can make an otherwise incomplete result `rejected`.

Incomplete relationship diagnostics include up to ten examples, returned/omitted accounting, reason counts and a recovery hint. Missing target indexing, conditional resolution, unsupported/ambiguous resolution and stale evidence remain uncertainty.

`approved` means no violations were found in the evaluated scope under those checks. `rejected` reports violations. `unknown` is not approval. Validation errors and operational failures can instead become MCP errors. Output shape differs between file, batch, staged and workspace scopes; clients should read the relevant status/count fields rather than assume one universal example schema.

## CLI behavior differs from MCP

`septum check` loads policy, synchronizes with content verification and audits the workspace. `--staged` uses the frozen-index auditor instead. `--strict` overrides enforcement for that invocation; `--json` selects structured reporting.

The default configuration returned by `ConfigLoader.getDefaultConfig()` uses `warn`; the raw configuration schema's enforcement default is `strict`. Follow the effective loaded policy, not one isolated schema default.

CLI violations are advisory with exit code 0 in warn mode; strict mode sets exit code 1. Unknown resolution likewise fails strict checks while warn checks can remain non-blocking. Unsupported/skipped source or operational errors can fail the command. A non-staged workspace with no domains reports `not_indexed` and fails only when strict.

MCP reports detected violations as rejected even with warn enforcement. Pre-write hooks also deny detected forbidden violations. “Warn” does not mean identical behavior across all entry points.

## Implementation and regression evidence

- [Rule evaluator](../../src/core/boundary/evaluator.ts), [MCP guards/results](../../src/mcp/tools/check-boundary.ts)
- [Frozen-index audit](../../src/core/boundary/staged-auditor.ts), [CLI check](../../src/cli/commands/check.ts)
- [Input validation](../../src/mcp/schemas.ts)
- [Evaluator tests](../../tests/unit/boundary-evaluator.test.ts), [resolution consumers](../../tests/unit/resolution-consumers.test.ts), [staged contracts](../../tests/unit/refactor-contracts.test.ts)
