# Deep TypeScript context

Deep context is the TypeScript-specific engine selected by `septum_symbol` with `action: "context"` and `context_mode: "deep"`. Its policy identifier is `referenced-typescript-declarations/v4`. It selects static declaration references, not a complete call or module-execution closure.

```json
{
  "action":"context",
  "context_mode":"deep",
  "query":"submitOrder",
  "file_path":"src/orders/service.ts",
  "budget_bytes":16384
}
```

## Selection and supported input

Targets must be indexed `.ts`, `.mts` or `.cts` declarations. This path does not accept JavaScript, TSX or other languages. Use [source context](septum-symbol.md) for those formats.

The engine requires one declaration. Ambiguous results include up to five candidate references and omission accounting. `symbol_ref`, `file_path` and `domain` narrow selection. Deep context rejects `include_source`, `source_start_line` and `source_line_limit`.

It creates an in-memory TypeScript program with `noLib: true` and `noResolve: true`. Indexed import relationships supply candidate resolution; the compiler host does not load the full dependency tree or certify project type correctness.

Selection starts with the target implementation, then supporting implementations and contracts. It follows supported local declarations/import bindings, including selected aliases, defaults and type-only references, up to three import edges. Type-only supporting classes can be projected to public instance signatures: constructors' bodies, private/protected/static members and initializers are excluded. Complex inferred types can become `unknown`.

Known literal arguments can prune supported conditional branches. A `selection` item records the arguments and pruning count. This is limited static evaluation, not general execution.

## Output items

| Kind | Meaning |
| --- | --- |
| `source` | Target or supporting declaration text, location and indexed hash |
| `type_contract` | Projected public instance signatures |
| `relationship` | Import relationship evidence |
| `selection` | Known-argument branch selection evidence |
| `diagnostic` | Unsupported, stale, unexpanded or resource-limited evidence |

Source spans are 1-based and inclusive. Source fragments additionally carry UTF-16 offsets so fragments of one declaration can be reassembled in order.

Results include policy, target identity, query/snapshot identities, freshness, completeness scope, accounting and `task_sufficiency: "unknown"`. `complete` applies only to this bounded selection policy; it does not certify enough context for a particular edit.

## Bounds and pagination

| Bound | Current value |
| --- | --- |
| Default response budget | 16,384 bytes |
| Accepted budget | 2,048–2,097,152 bytes |
| Selected item cap | 256 |
| Bound-file cap | 64 |
| Selected source read budget | 8 MiB |
| Import depth | Three edges |

The page builder measures the serialized content response envelope, including JSON encoding and `output_bytes`. This is not a token budget or a cap on the MCP transport's complete outer protocol envelope. Oversized declaration text can be fragmented while preserving surrogate pairs and CRLF boundaries.

Continue with the returned `continuation`, keeping target, workspace, policy, configuration and budget unchanged. Tokens bind query and snapshot identity. Invalid tokens return `invalid_continuation`; changed observed inputs/index/selection can return `stale_continuation`. Restart retrieval in either case.

Pagination does not recover declarations omitted by selection-capacity limits. Inspect `omitted_by_capacity` and `unexpanded_dependency_files`. `budget_too_small` asks for a larger budget when metadata or the next fragment cannot fit.

## Freshness and failure behavior

Each selected source read is compared against its indexed hash. A mismatch produces `source_differs_from_index` and omits that source's indexed slice. Unavailable or escaping source produces diagnostics. An index identity change during retrieval returns `index_changed`.

Other outcomes include `invalid_query`, `not_found`, `ambiguous`, `stale_reference`, `unsupported` and `invalid_budget`; public schema validation can reject bad inputs before these handler paths run. Incomplete indexes and source/resource omissions make the result partial. Side-effect imports, module execution, reexports and unsupported bindings can remain unexpanded with diagnostics.

## Implementation and regression evidence

- [Selection and identity checks](../../src/core/retrieval/context.ts)
- [TypeScript binder and projections](../../src/core/retrieval/typescript-references.ts)
- [Byte accounting and fragmentation](../../src/core/retrieval/context-page.ts)
- [Retrieval baseline](../../tests/unit/retrieval-baseline.test.ts), [pruning](../../tests/unit/pruning-regressions.test.ts), [mode contracts](../../tests/unit/refactor-contracts.test.ts)

For policy ownership and synchronization, see [workspace lifecycle](workspace-lifecycle.md).
