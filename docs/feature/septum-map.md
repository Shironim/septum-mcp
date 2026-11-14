# septum_map

## Catalog

`action: "catalog"` is the default. The response uses `schema: "navigation/v1"` and provides navigation rather than source bodies or per-file declaration inventories.

```json
{"action":"catalog","workspace_path":"/path/to/project"}
```

With no domain, file or archetype filter, the workspace view returns domain roots, file counts, dependency policies and domain-to-domain import edges. Its `files` array is empty. Static entrypoints have `evidence: "static_catalog"` and `runtime_verified: false`.

```json
{"action":"catalog","domain":"orders","file_filter":"service","detail_level":"full"}
```

A scoped view returns indexed file records with path, domain, archetype, symbol count and an anchor for subsequent symbol lookup. Domain matching is case-insensitive. `file_filter` is a case-insensitive path substring; `archetype_filter` is an exact archetype match.

Files are sorted by static entrypoint membership, connection degree and path. Scoped dependencies use file paths and can include incoming/outgoing edges to neighboring domains. A compact domain view without file/archetype filters omits intra-domain edges; full detail or narrower filters can expose them.

| Input | Behavior |
| --- | --- |
| `detail_level` | `compact` by default; `full` expands navigation coverage |
| `file_limit` | 1–100; default 40 compact or 100 full |
| `file_offset` | Nonnegative offset into sorted matching files |
| `include_evidence` | Requires a file filter matching exactly one indexed file |
| `include_capabilities` | Adds parser and semantic-adapter capability metadata |

Dependency edges are capped at 100 and entrypoints at 20. `pagination.next_file_offset` appears when more matching files remain. Keep filters unchanged when paging. `accounting` records returned/omitted items; edge omissions can include scope filtering as well as caps. These are item bounds, not a serialized byte budget.

Evidence mode adds up to 20 raw import relationships originating in the selected file, evidence accounting and up to five unresolved examples. It does not turn imports into calls.

`health` includes sync state, slice-dirty status, unresolved relationship counts, unsupported/skipped counts and bounded reasons. Its coverage remains partial. Unknown domains return `not_found` and available-domain suggestions. An uninitialized workspace is handled by the server's unindexed diagnostic path.

## Registration

```json
{
  "action":"register",
  "name":"orders",
  "root":"src/orders",
  "allowed_dependencies":["shared"],
  "forbidden_dependencies":["billing"],
  "ingest_now":true
}
```

Name/domain and root are required. Roots must be contained in the workspace. Different names cannot own the same physical root; nested roots are supported. Registration retains omitted policy arrays/maps; explicit empty arrays/maps clear them.

When `septum.config.json` exists, it owns policy. Registration updates that file and SQLite and reports `policy_owner: "file"`. Otherwise SQLite owns registered policy and the response reports `"database"`. File updates use an exclusive lock, snapshot checks and atomic rename. A file-write failure rolls back the surrounding database transaction. File and database commits are not a distributed transaction; a crash can leave them out of step.

`ingest_now` defaults to false. A successful registration alone does not certify source-index freshness. With ingestion enabled, synchronization follows registration; an ingestion failure need not undo the already recorded policy.

## Automatic topology discovery

Discovery uses filesystem layout and project manifests to infer language, framework, project type, architecture and initial domains. It is a heuristic configuration generator.

- Monorepos inspect `apps`, `packages`, `modules` and `libs`. Duplicate package names receive disambiguating names. Apps allow package domains; non-app domains forbid app domains.
- Modular layouts include variants of `app/Domain`, `src/domains`, `src/modules` and `features`. Generated dependencies include shared/common/root names in the applicable branch.
- Layered layouts generate domains from detected source layers.
- Go layouts can generate `pkg`, one domain per `internal/<subdir>`, and `cmd-<subdir>` entrypoint domains. Without source-bearing subdirectories, direct `internal` or `cmd` domains can be used.

**Current Go limitation:** generated forbidden lists use literal names `internal` and `cmd`, even when discovered domains are named `orders` or `cmd-api`. Those lists do not match the renamed domains. In warn mode, a `pkg` import into `cmd/api` can therefore produce no violation; strict allowlists can reject it independently. Discovery does not certify Go visibility or external consumers.

## Implementation and regression evidence

- [Navigation builder](../../src/core/discovery/navigation.ts), [catalog handler](../../src/mcp/tools/get-domain-catalog.ts)
- [Registration](../../src/mcp/tools/register-domain.ts), [policy file writes](../../src/core/config/loader.ts)
- [Topology discovery](../../src/core/discovery/topology-detector.ts)
- [Navigation/output regressions](../../tests/unit/refactor-contracts.test.ts), [policy ownership](../../tests/unit/policy-ownership.test.ts), [domain ownership](../../tests/integration/domain-ownership.py)

These paths describe source and test ownership; a linked test file is not a claim that every discovery layout or live installation was exercised.
