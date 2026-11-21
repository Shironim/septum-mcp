# septum_symbol

The public actions are `locate`, `context` and `impact`. `inspect` normalizes to `context`. Without an explicit action, context-related options select context; otherwise the default is locate.

Common selectors are `query` (alias `symbol`), `domain`, `file_path`, `symbol_ref`, `format` (`"text"` by default; `"json"` for structured payloads) and `workspace_path`. Use the reference returned for a particular declaration when names are ambiguous. A reference includes its indexed source identity; after index content changes, stale references are rejected.

## Locate

```json
{"action":"locate","query":"OrderController::store"}
```

The locator parses supported PHP-style undefined-method errors, Python missing-attribute errors, class/member syntax (`::`, `->`, `.`) and bare names. Fuzzy suggestions prioritize exact camelCase/snake_case word-boundary token matches ahead of Damerau-Levenshtein edit similarity, combined with prefix/substring signals. Suggestions are candidates, not confirmed declarations.

A successful response includes `found`, `file_path`, `container_name`, `exact_symbol`, `symbol_ref`, suggestions and sibling methods. The nested coordinates are:

```json
{"exact_symbol":{"line_start":52,"line_end":78,"start_line":52,"end_line":78,"total_lines":27}}
```

This is a field excerpt, not a complete response. `start_line`/`end_line` are available across `exact_symbol`, `suggestions`, `symbol_ref`, and file-list candidates (`exact_symbol` and `suggestions` also retain `line_start`/`line_end` for backward compatibility).

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
| No source options and target is `.ts`, `.tsx`, `.mts` or `.cts` | Deep context |
| Other known target extension | Bounded source inspection |

Without a resolved target path, automatic selection initially attempts deep context. Setting `context_mode: "source"` or passing a source option selects source inspection and rejects `budget_bytes` and `continuation`. When automatic selection chooses source inspection for a non-TypeScript target, it accepts `budget_bytes` and rejects `continuation`. See [deep context](symbol-context-contract.md) for its response format.

## Bounded source behavior

Source is included by default on this path. `source_start_line` defaults to the declaration start; `source_line_limit` defaults to 120 and is capped at 200. The requested start must be inside the indexed declaration. A truncated source slice supplies `next_start_line`.

In automatic source mode, the byte budget applies to `source_slice.text`. The handler removes trailing lines first. If the first line alone exceeds the budget, it cuts that line at the byte offset before decoding it as UTF-8. A cut inside a multibyte character can produce a replacement character. `next_start_line` points to the following line, so it cannot recover the omitted portion of a cut line. Metadata and any delegated source are outside this budget.

`source_slice.status` can be `current`, `stale`, `invalid_range`, `unavailable`, `out_of_scope` or `ambiguous`. The handler reads disk content and compares its hash to the index before using the target's coordinates. Stale source asks for `septum sync`.

For slices of at most 15 lines, or with `semantic_depth: 2`, the handler attempts one-hop delegated implementation expansion. It recognizes selected PHP, TypeScript/JavaScript, Python, Go, Rust (`Arc`/`Box`/`Rc`/`&`), static-call patterns, and same-file local helper calls, inferring dependency types from declarations or naming. Resolution is heuristic and can fail or select a similarly named target. The delegated text is not covered by the primary 120/200-line cap and is read using indexed coordinates without a separate delegated-target hash comparison. It must not be treated as a verified runtime callee.

`include_source: false` returns declaration details and, when dependencies are enabled, injected dependencies/outbound-call inference instead of a source slice. Relationship and connected-file lists are compacted to at most 20 with omission counts. Source mode has no deep-context serialized byte guarantee.

## Impact

```json
{"action":"impact","query":"cancelOrder","file_path":"src/orders/service.ts"}
```

Impact combines indexed declarations/import dependents, supported import-bound TypeScript/JavaScript call sites and legacy lexical caller hints. Candidate traversal includes importing files, same-file callers and selected same-package/namespace candidates. It does not establish complete dynamic dispatch.

The response separates `call_sites`, `runtime_imports`, `type_only_imports`, `import_dependents`, legacy `inbound_callers` and resolution warnings, with `call_sites_count`, `runtime_imports_count` and `type_only_imports_count` in `impact_summary`. Default `format: "text"` renders a grouped summary (`Call Sites`, `Runtime Imports`, `Type-Only Imports`, and warnings) without duplicating file entries. It reports `coverage: "partial"`, `inbound_callers_complete: false` and an advisory risk scope. Risk uses distinct caller files/domains:

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

- [Symbol tool handlers (`locate`, `context`, `impact`)](../../src/mcp/tools/symbol.ts), [schemas](../../src/mcp/schemas/symbol.ts), [compact text formatter](../../src/mcp/formatters/compact-text.ts)
- [Query parsing and fuzzy locator](../../src/core/resolver/symbol-locator.ts)
- [Source inspection/delegation](../../src/core/retrieval/source-context.ts), [symbol details](../../src/core/retrieval/symbol-details.ts)
- [Caller analysis](../../src/core/resolver/symbol-impact.ts)
- [Evidence enrichment](../../src/core/retrieval/symbol-evidence.ts)
- [Locator tests](../../tests/symbol-locator.test.ts), [identity tests](../../tests/unit/symbol-identity.test.ts), [retrieval evidence](../../tests/unit/symbol-retrieval-evidence.test.ts), [mode selection](../../tests/unit/refactor-contracts.test.ts), [v0.4.0 output curation](../../tests/unit/v040-output-curation.test.ts)
