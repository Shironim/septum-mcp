# Workspace lifecycle and stored state

## Policy and database selection

SQLite owns registered domains and settings. The standard workspace database is `.septum/septum.db`. `ConfigLoader.load()` reads SQLite or defaults. Loading policy does not discover topology or initialize an index. Enforcement defaults to `warn`, and default ignores include `.septum/**`.

MCP workspace discovery and generated hook wrappers use `.septum/septum.db` as the initialization marker. `septum init` discovers topology, sets up workspace integrations, and synchronizes the index. Domain registration updates SQLite as described in [map](septum-map.md).

### Upgrade from file-based configuration

Support for `septum.config.json` has ended. Septum ignores the file, including its domain rules, settings, and `db_path`. Existing policy in the standard workspace database continues to apply. Septum does not import the old file or locate a custom database through it.

For a workspace that relied on the file or a custom database, run `septum init` from the workspace root to prepare the standard database and review the discovered domains. Use `septum_map(action='register')` to reapply explicit domain roots and dependency rules. Review the effective policy before relying on boundary verdicts or hooks. Without the standard database, the MCP catalog reports `NOT_INDEXED` and generated pre-write and post-write wrappers exit without processing the edit.

## SQLite facts

The database enables WAL, foreign keys, a 5-second busy timeout, `synchronous=NORMAL`, `temp_store=MEMORY` and a 16 MiB page cache (`cache_size=-16000`). Its principal stored facts include:

| Table | Contents |
| --- | --- |
| `domains` | Root ownership and dependency policies |
| `files` | Paths, content hashes, source metadata and archetypes |
| `symbols` | Names, indexed `leaf_name` suffixes, kinds, signatures and indexed line spans |
| `dependencies` | Extracted import targets/statements, source lines and indexed `resolved_target_file` column |
| `vertical_slices` | Static entrypoint records and serialized chains |
| `repo_meta` | Sync state, revisions, observed inputs and diagnostics |

These records are an index of supported static evidence, not authoritative application state. Corrupt database initialization raises an error; it does not automatically delete/replace database files.

## Source membership and ingestion

The shared source inventory applies configured ignores, workspace containment and recognized-language filtering. Contained file symlinks are eligible; directory symlinks are not traversed. Recognized unsupported formats can generate diagnostics. Non-ENOENT scan/I/O errors propagate instead of becoming empty successful scans.

Ingestion scans the workspace once, partitions files across registered domains in a single longest-prefix pass, extracts declarations/imports (using native Tree-Sitter `descendantsOfType` import queries for Python/TypeScript, zero-copy `content.slice` declaration headers across language extractors, and the TypeScript compiler AST fallback when `tree-sitter-wasms` hits `syntax_recovery` on valid modern TS/TSX), and publishes the slice catalog. Post-sync verification compares the final file inventory against `initialStats` and re-`statSync`s only the files actually parsed during the sync pass (`ingestedFullPaths`). Semantic adapters can inspect eligible source outside domain roots. Duplicate physical roots are rejected; nested roots are supported by ownership resolution.

Warm synchronization can skip parsing after metadata and content verification agree. Verification/rebuild options read content. Changed source is stored in bounded transactions after verifying file metadata (`size`, `mtimeMs`, `ctimeMs`, `ino`) and re-hashing only when metadata changed. Bulk rebuilds on repositories with 500 or more files automatically widen commit batches to 250 files / 4 MiB. One retry is allowed for the supported “source changed during synchronization” condition. `init` displays four sequential stage milestones (`Scanning files`, `Parsing code`, `Resolving refs & domains`, `Linking entrypoints & slices`) without inline timings; detailed per-stage timings (`scan_ms`, `parse_ms`, `commit_ms`, `slice_ms`) are written to `.septum/septum.log`.

Synchronization records `running`, then `complete` or `error`, with error metadata. Earlier committed batches can remain after a later failure; there is no workspace-wide rollback guarantee. Oversized or unsupported files are recorded and constrain downstream analysis.

Import evidence freshness refers to the importing source. It does not guarantee every transitive consumer was reparsed. Semantic dirty tracking and observed input identities govern slice rebuilds. Deep context separately validates hashes of source it returns. Existing daemons must restart to load changed implementation code.

Supported manifest/project changes also trigger watcher reconciliation and are included in staged snapshots through a shared interpretation-input predicate. See [import resolution](import-resolution.md) for language-specific ownership and limits.

## MCP workspace management

Workspace resolution uses explicit `workspace_path`, supported environment roots, file hints and known/fallback roots. The manager rejects unsuitable roots such as the filesystem root, home directory and known app-host locations. Multi-project callers should supply explicit workspace paths.

Contexts hold database, repository, parser pipeline, resolver, watcher and per-workspace `ReadWriteWorkQueue` state. Leases prevent eviction during active use. Each workspace's `ReadWriteWorkQueue` allows concurrent read-only tool requests (`runRead`) when no writer is active or queued, while serializing mutations (`runWrite` for initialization, watcher flushes, domain registration and dirty slice-catalog rebuilds) with FIFO fairness and a global server cap (`RESOURCE_LIMITS.maxQueuePending = 50`). Watchers coalesce events, periodically verify content, rebuild the slice catalog directly when single-file ingestion marks `slices_dirty` (avoiding a full workspace rescan), and fall back to polling when watch resources are exhausted. Query dispatch awaits readiness and flushes pending work, then reloads effective policy and checks ownership in the workspace queue immediately before executing the tool.

Tool calls that provide an MCP progress token receive notifications for preparation, index freshness checks, and execution. A cancelled request can stop waiting for shared initialization or reconciliation. The workspace retains ownership of that work until it settles or the workspace closes.

The initial workspace comes from `SEPTUM_WORKSPACE_ROOT`, then `WORKSPACE_ROOT`, or the process's current directory when it has a project marker. Septum validates this root before opening stdio. Index-dependent requests await workspace readiness. [MCP resources](mcp-resources-and-prompts.md) use that workspace. Tool calls can select other roots without changing the resource target.

| Current resource setting | Value |
| --- | --- |
| Cached workspaces | 4 |
| Idle expiry | 10 minutes |
| Watch budget | 8,192 |
| Pending watcher paths | 1,000 |
| Event debounce | 300 ms |
| Poll interval | 5 seconds |
| Content verification interval | 60 seconds |
| Source read limit per file | 2 MiB |
| Ingestion batch limits | 50 files / 1 MiB (250 files / 4 MiB on bulk rebuilds >= 500 files) |
| Pending serial queue limit | 50 |
| In-flight workspace request limit | 50 |
| Cooperative MCP tool deadline | 120 seconds |
| Shutdown wait setting | 5 seconds |

These are implementation settings, not latency or memory guarantees. Cancellation is checked at cooperative points; it is not atomic rollback or forced termination of every synchronous parse/filesystem operation.

## Revisions and telemetry

Parser/semantic implementation fingerprints include loaded implementation/runtime and grammar assets. Resolution records revision/configuration evidence and observed interpretation inputs. Revision metadata does not establish that another installed process is running this checkout.

Each handled MCP tool request records one final event with a server-generated trace ID, the last request stage, duration, tool status, available analysis outcome, and response size. Validation and workspace-resolution failures are attributed to the server's initial workspace and omit raw details. Tool status describes the MCP result, so an analysis outcome such as `NOT_INDEXED` can appear on a successful response.

Events go to `.septum/septum.log` when the workspace already has a `.septum` directory. Error, large-response and slow-call events also go to stderr. Tool events are capped at 4 KiB. The writer rotates before a new line would exceed 2 MiB, keeping one previous file as `septum.log.1`.

Use `septum stats [workspace] --json` for counts by tool and action, recent errors, and duration and response-size percentiles across up to 500 tool events from the tails of both files. The workspace defaults to the current directory. Older events without response-size measurements still count as calls.

Default logs keep allowlisted options and omit raw inputs, response previews and detailed exception text. Set `SEPTUM_LOG_INPUT=1`, `SEPTUM_LOG_PREVIEW=1` or `SEPTUM_LOG_ERROR_DETAILS=1` to enable each independently. The existing `SEPTUM_DEBUG_TELEMETRY=1` switch enables all three.

## Implementation and regression evidence

- [Configuration](../../src/core/config/loader.ts), [database](../../src/core/database/client.ts)
- [Inventory](../../src/core/resources/source-inventory.ts), [ingestion](../../src/core/ingestion/pipeline.ts), [slice publication](../../src/core/resolver/slice-catalog.ts)
- [Manager](../../src/mcp/workspace-manager.ts), [watcher](../../src/mcp/workspace-watcher.ts), [limits](../../src/core/resources/limits.ts)
- [Fingerprinting](../../src/core/parser/implementation-fingerprint.ts), [telemetry](../../src/core/telemetry/telemetry.ts)
- [Policy ownership](../../tests/unit/policy-ownership.test.ts), [source consistency](../../tests/unit/source-read-consistency.test.ts), [workspace lifecycle](../../tests/unit/memory-workspaces.test.ts), [database corruption](../../tests/unit/database-corruption.test.ts), [observability](../../tests/mcp-observability.test.ts)
