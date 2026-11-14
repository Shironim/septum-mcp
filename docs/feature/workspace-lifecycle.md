# Workspace Lifecycle, Policy Ownership and Index Freshness

## Policy and database location

`ConfigLoader.load()` reads configuration without discovery, initialization or policy writes. When `septum.config.json` exists, it owns policy. Otherwise registered SQLite domains and settings supply it. `resolveDatabasePath()` resolves `settings.db_path` consistently for CLI commands, hooks and MCP workspaces.

`init` performs explicit discovery/scaffolding and initial sync. Ingestion with no configured domains can discover topology. `map register` updates the authoritative owner and returns `policy_owner`. See [registration](septum-map.md) for persistence and recovery limits.

## Stored state

SQLite uses WAL, foreign keys and a busy timeout.

| Table | Facts |
| --- | --- |
| `domains` | Domain roots and effective dependency rules |
| `files` | Ownership, content hash, mtime, size and archetype |
| `symbols` | Declarations, signatures and line spans |
| `dependencies` | Import targets and source coordinates |
| `vertical_slices` | Static entrypoint catalog |
| `repo_meta` | Sync status, revisions, observed inputs and diagnostics |

No schema migration is needed for the consistency refactor; extraction reports use existing metadata storage.

## Source inventory and ingestion

`resources/source-inventory.ts` owns membership for ingestion and semantic adapters, applying configured ignores, containment and a common symlink policy. Contained file symlinks are eligible; directory symlinks are not traversed. Permission/I/O errors propagate instead of becoming an apparently empty scan. Semantic source can be outside registered domain roots.

Warm ingestion skips parsing after metadata and previously verified content agree. Verification/rebuild reads content. Changed files are stored in bounded transactions after hashes are checked. A later failure can follow earlier committed batches: inspect `sync_state` and `sync_error` rather than assuming workspace-wide rollback.

Source byte limits produce skipped-file diagnostics. Changes to types/barrels can dirty semantics. Import freshness describes the importing source hash; it does not promise every transitive consumer was reparsed. Deep context checks the hashes of declarations it reads and diagnoses source/index differences. An outdated `symbol_ref` is rejected when its indexed source identity no longer matches. Synchronize before retrieving current contracts from modified source.

## Slice publication

`resolver/slice-catalog.ts` owns extraction and transactional catalog publication for ingestion and query refresh. It records input hashes, path/directory observations, membership and adapter counts. Failure retains a dirty catalog and is surfaced to callers.

Generic routes complement uncovered files as described in [slice](septum-slice.md). Generic chains are built to maximum supported depth once; query depth limits returned expansion. Adapter counts describe the last successful extraction of supported patterns, not complete framework coverage.

## Revisions, watchers and telemetry

Implementation fingerprints bind loaded code/runtime and grammar assets. Resolution records manifests it used. A daemon must restart to load implementation changes.

Watchers coalesce source/config events and periodically verify content. Watch exhaustion falls back to polling. A bounded serial queue orders work; leases prevent active-workspace eviction. These controls do not guarantee zero filesystem-event latency.

Telemetry records sizes, timing, transport status and selected options. Analysis outcome (`partial`, `unknown`, `rejected`, etc.) is separate from transport success. Raw arguments, errors and previews are omitted by default. `SEPTUM_DEBUG_TELEMETRY=1` enables those details for local debugging.
