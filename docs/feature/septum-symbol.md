# septum_symbol

The public actions are `locate`, `context` and `impact`. `inspect` normalizes to `context`. Without an explicit action, context-related options select context; otherwise the default is locate.

Common selectors are `query` (alias `symbol`), `domain`, `file_path`, `symbol_ref` and `workspace_path`. Use the reference returned for a particular declaration when names are ambiguous. A reference includes its indexed source identity; after index content changes, stale references are rejected.

## Locate

```json
{"action":"locate","query":"OrderController::store"}
```

The locator parses supported PHP-style undefined-method errors, Python missing-attribute errors, class/member syntax (`::`, `->`, `.`) and bare names. Fuzzy suggestions combine Damerau-Levenshtein, identifier-token overlap and prefix/substring signals. Suggestions are candidates, not confirmed declarations.

A successful response includes `found`, `file_path`, `container_name`, `exact_symbol`, `symbol_ref`, suggestions and sibling methods. The nested coordinates are:

```json
{"exact_symbol":{"line_start":52,"line_end":78,"total_lines":27}}
```

This is a field excerpt, not a complete response. `symbol_ref` and file-list candidates use `start_line`/`end_line` instead. Do not assume every object shares one coordinate spelling.

Multiple declarations produce `ambiguous` candidates. An absent target can produce suggestions or `not_found`. An empty query with `file_path` lists indexed declarations in that file. `limit` defaults to 10 and caps returned candidates/suggestions where applied. Symbols exceeding 300 indexed lines receive `complexity_smell`; line count is not a control-flow complexity measurement.

When the handler receives an ingestion pipeline, it can initialize an empty catalog, refresh a found target and try bounded candidate-file discovery on a miss. Refresh failures become diagnostics. Freshness metadata can still mark coordinates stale or unavailable; a found result alone is insufficient for editing.

## Context engine selection

```json
{"action":"context","context_mode":"source","query":"OrderController::store","include_source":true}
```

| Selection | Engine |
| --- | --- |
| Explicit `context_mode: "deep"` | TypeScript declaration/reference context |
| Explicit `context_mode: "source"` | Bounded source inspection |
| No mode, but `include_source`, `source_start_line` or `source_line_limit` supplied | Bounded source inspection |
| No bounded option and target is `.ts`, `.mts` or `.cts` | Deep context |
| Other known target extension | Bounded source inspection |

Without a resolved target path, automatic selection initially attempts deep context. Deep mode rejects bounded source options. Source mode rejects `budget_bytes` and `continuation`. See [deep context](symbol-context-contract.md) for its distinct output contract.

## Bounded source behavior

Source is included by default on this path. `source_start_line` defaults to the declaration start; `source_line_limit` defaults to 120 and is capped at 200. The requested start must be inside the indexed declaration. A truncated source slice supplies `next_start_line`.

`source_slice.status` can be `current`, `stale`, `invalid_range`, `unavailable`, `out_of_scope` or `ambiguous`. The handler reads disk content and compares its hash to the index before using the target's coordinates. Stale source asks for `septum sync`.

For slices of at most 15 lines, or with `semantic_depth: 2`, the handler attempts one-hop delegated implementation expansion. It recognizes selected PHP, TypeScript/JavaScript, Python, Go and static-call patterns and infers dependency types from declarations or naming. Resolution is heuristic and can fail or select a similarly named target. The delegated text is not covered by the primary 120/200-line cap and is read using indexed coordinates without a separate delegated-target hash comparison. It must not be treated as a verified runtime callee.

`include_source: false` returns declaration details and, when dependencies are enabled, injected dependencies/outbound-call inference instead of a source slice. Relationship and connected-file lists are compacted to at most 20 with omission counts. Source mode has no deep-context serialized byte guarantee.

## Impact

```json
{"action":"impact","query":"cancelOrder","file_path":"src/orders/service.ts"}
```

Impact combines indexed declarations/import dependents, supported import-bound TypeScript/JavaScript call sites and legacy lexical caller hints. Candidate traversal includes importing files, same-file callers and selected same-package/namespace candidates. It does not establish complete dynamic dispatch.

The response separates `import_dependents`, `call_sites`, legacy `inbound_callers` and resolution warnings. It reports `coverage: "partial"`, `inbound_callers_complete: false` and an advisory risk scope. Risk uses distinct caller files/domains:

| Risk | Condition |
| --- | --- |
| High | More than five files or more than two domains |
| Medium | At least two files or at least two domains, unless high |
| Low | Remaining indexed cases |
| Unknown | No symbol/dependency index evidence |

`total_dependents` counts returned legacy inbound entries; it is not a complete count of runtime consumers.

## Evidence metadata

Locate, source inspection and impact attach `retrieval` metadata describing selected-source freshness, partial completeness, observed stale/unavailable inputs and reasons. Selected-source freshness does not certify the full dependency closure. Parser capabilities distinguish declaration extraction from import resolution and runtime dispatch.

## Implementation and regression evidence

- [Dispatch](../../src/mcp/tools/symbol.ts), [schemas](../../src/mcp/schemas.ts)
- [Locate handler](../../src/mcp/tools/locate-symbol.ts), [query parsing](../../src/core/resolver/symbol-locator.ts)
- [Source inspection/delegation](../../src/mcp/tools/get-symbol.ts)
- [Impact response](../../src/mcp/tools/get-symbol-impact.ts), [caller analysis](../../src/core/resolver/symbol-impact.ts)
- [Evidence enrichment](../../src/core/retrieval/symbol-evidence.ts)
- [Locator tests](../../tests/symbol-locator.test.ts), [identity tests](../../tests/unit/symbol-identity.test.ts), [retrieval evidence](../../tests/unit/symbol-retrieval-evidence.test.ts), [mode selection](../../tests/unit/refactor-contracts.test.ts)
