# septum_boundary and CLI checks

Boundary analysis applies configured domain rules to statically resolved imports and detects selected domain/file cycles. Approval concerns the analyzed static scope; it does not certify runtime behavior or complete language resolution.

## Rules actually implemented

| Rule | Trigger |
| --- | --- |
| `forbidden_dependency` | Resolved target domain occurs in the source domain's forbidden list |
| `disallowed_dependency` | In strict mode, a cross-domain target is absent from the source domain's allowed list |
| `circular_dependency` | DFS finds a cycle in the constructed domain or file import graph |
| `unmapped_domain` | A proposal source has no registered domain, or a strict check resolves an internal file outside all registered roots |

Forbidden checks apply in both warn and strict modes. Same-domain imports do not require allowlist membership. Cycle analysis excludes recognized type-only imports; domain-cycle construction also excludes the virtual `root` aggregator. These are graph checks over available resolved evidence, not a proof of all runtime cycles.

**Unmapped targets:** In `strict` mode, if a mapped source imports a real internal workspace file that resolves outside all declared domain roots, the evaluator reports `unmapped_domain` (`target_domain: "unmapped"`). In `warn` mode, unmapped targets are not rejected directly (though incomplete-resolution guards can still return `unknown`).

Domain policies match domain names, not directory categories.

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

When the loaded configuration declares no domains, MCP boundary checks use the indexed domain policies and retain the loaded settings. A workspace-wide audit with zero available domain policies returns `unknown`. A domain audit with no indexed files also returns `unknown` when the audit finds no known violations.

```json
{"scope":"staged"}
```

Staged scope freezes the Git index using `git write-tree`. Source and interpretation files are materialized from the resulting tree, including unchanged source needed for import/cycle resolution. Unstaged source does not replace staged bytes. Manifest/interpretation changes can widen the affected scope.

Staged analysis rejects snapshots containing symlinks or submodules. Snapshot entry-count, source-size and total-source-byte limits apply. Non-source binary entries are inventoried without materializing their contents or applying the source-size cap. Unmapped source files are skipped by the staged source loop; staged approval does not establish domain ownership for every file.

## Completeness and statuses

The MCP handler requires completed workspace synchronization:

| Status | Meaning |
| --- | --- |
| `approved` | No violations were found in the evaluated static scope |
| `rejected` | One or more policy or cycle violations were detected (even if resolution elsewhere is incomplete) |
| `unknown` | Analysis could not complete reliably (missing/running/error sync, relevant skipped files, or unsupported sources) |

- **Incomplete evidence:** Stale sources and unresolved import relationships emit diagnostics with up to ten examples, returned/omitted counts, reason counts, and a recovery hint. Missing target indexing, conditional resolution, unsupported/ambiguous resolution, and stale evidence remain uncertainty (`unknown` is not approval).
- **Response fields:** Normal results include `status`, `scope`, `enforcement_mode`, `total_violations` and `violations`. File batches also include per-file `results`. Domain and workspace audits include the number of loaded domain policies in `total_domains_checked`. A domain filter selects violations touching that domain. Staged results report the staged file count in `total_checked`.
- **Early results and errors:** An incomplete check may return a shorter payload with sync state, skipped files, unsupported files, or resolution diagnostics. Validation and operational failures can return MCP errors. Read `status` before using counts or scope-specific fields.

## CLI behavior differs from MCP

`septum check` loads policy, synchronizes with content verification, and audits the workspace (`--staged` uses the frozen-index auditor; `--strict` overrides enforcement for that invocation; `--json` selects structured reporting). Default enforcement is `warn`.

Enforcement differs by entry point:

| Entry point | `warn` mode | `strict` mode |
| --- | --- | --- |
| CLI (`septum check`) | Advisory (exit code `0`); `not_indexed` when no domains | Failing (exit code `1`); fails on violations, unknown resolution, and `not_indexed` |
| MCP (`septum_boundary`) | Reports detected violations as `rejected` | Reports detected violations as `rejected` |
| Pre-write hook (`septum hook pre-write`) | Denies detected forbidden violations | Denies detected forbidden violations |

Unsupported/skipped source or operational errors can also fail `septum check`. "Warn" does not mean identical behavior across all entry points.

## Implementation and regression evidence

- [Rule evaluator](../../src/core/boundary/evaluator.ts), [audit core](../../src/core/boundary/audit.ts), [MCP boundary handler](../../src/mcp/tools/boundary.ts), [compact text formatter](../../src/mcp/formatters/compact-text.ts)
- [Frozen-index audit](../../src/core/boundary/staged-auditor.ts), [CLI check](../../src/cli/commands/check.ts)
- [Input validation](../../src/mcp/schemas/boundary.ts)
- [Evaluator tests](../../tests/unit/boundary-evaluator.test.ts), [resolution consumers](../../tests/unit/resolution-consumers.test.ts), [staged contracts](../../tests/unit/refactor-contracts.test.ts), [v0.4.0 output curation](../../tests/unit/v040-output-curation.test.ts)


Workspace and domain audits reuse one set of indexed dependencies, import resolutions, and source freshness observations for their verdict and diagnostics. Freshness checks also cover in-scope indexed files without imports. This evidence is collected for each audit and reflects the files observed during that collection.

## Freshness recovery

When an MCP working-tree boundary audit detects stale source, Septum releases the analysis queue, requests one shared workspace reconciliation, and evaluates the audit once more. This applies to the boundary tool and the `septum://boundaries` resource. Failed recovery or remaining stale evidence leaves the audit inconclusive unless known violations support rejection. Staged audits continue to use Git index contents.

## Output format and response budget

`format` defaults to `"text"` (compact markdown summary of verdict, violations, circular dependencies and impact); pass `format: "json"` for the structured JSON payload. Pass `max_bytes` from 512 to 2,097,152 to bound the UTF-8 byte size of the serialized MCP tool result (using compact JSON when `format: "json"`). If the full result exceeds the budget, it returns `BUDGET_RESPONSE_TOO_LARGE` with the required byte count so the caller can increase the budget or narrow the scope.
