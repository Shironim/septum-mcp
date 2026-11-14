# Workspace lifecycle and stored state

## Policy and database selection

`ConfigLoader.load()` reads `septum.config.json` when present; otherwise it reads policy/settings from SQLite or defaults. Loading policy does not perform topology discovery or initialize an index.

The file owns policy when present. Otherwise SQLite owns registered domains/settings. `resolveDatabasePath()` resolves relative `settings.db_path` from the workspace and preserves absolute paths and `:memory:`. The default path is `.septum/septum.db`.

Custom paths are supported by command/workspace database resolution, but two surrounding checks still use the default path:

- MCP initialization recognition checks for `septum.config.json` or `.septum/septum.db`.
- Generated hook wrappers require `.septum/septum.db` before dispatch.

A custom database alone therefore does not satisfy those checks. See [hooks](septum-hooks.md).

Registration updates the authoritative policy owner as described in [map](septum-map.md). `init` performs explicit discovery/scaffolding and initial synchronization. Ingestion without configured domains first considers stored domains, then discovery.

## SQLite facts

The database enables WAL, foreign keys, a 5-second busy timeout and `synchronous=NORMAL`. Its principal stored facts include:

| Table | Contents |
| --- | --- |
| `domains` | Root ownership and dependency policies |
| `files` | Paths, content hashes, source metadata and archetypes |
| `symbols` | Names, kinds, signatures and indexed line spans |
| `dependencies` | Extracted import targets/statements and source lines |
| `vertical_slices` | Static entrypoint records and serialized chains |
| `repo_meta` | Sync state, revisions, observed inputs and diagnostics |

These records are an index of supported static evidence, not authoritative application state. Corrupt database initialization raises an error; it does not automatically delete/replace database files.

## Source membership and ingestion

The shared source inventory applies configured ignores, workspace containment and recognized-language filtering. Contained file symlinks are eligible; directory symlinks are not traversed. Recognized unsupported formats can generate diagnostics. Non-ENOENT scan/I/O errors propagate instead of becoming empty successful scans.

Ingestion assigns source to registered domains, extracts declarations/imports and publishes the slice catalog. Semantic adapters can inspect eligible source outside domain roots. Duplicate physical roots are rejected; nested roots are supported by ownership resolution.

Warm synchronization can skip parsing after metadata and content verification agree. Verification/rebuild options read content. Changed source is stored in bounded transactions after hashes are checked. One retry is allowed for the supported “source changed during synchronization” condition.

Synchronization records `running`, then `complete` or `error`, with error metadata. Earlier committed batches can remain after a later failure; there is no workspace-wide rollback guarantee. Oversized or unsupported files are recorded and constrain downstream analysis.

Import evidence freshness refers to the importing source. It does not guarantee every transitive consumer was reparsed. Semantic dirty tracking and observed input identities govern slice rebuilds. Deep context separately validates hashes of source it returns. Existing daemons must restart to load changed implementation code.

Supported manifest/project changes also trigger watcher reconciliation and are included in staged snapshots through a shared interpretation-input predicate. See [import resolution](import-resolution.md) for language-specific ownership and limits.

## MCP workspace management

Workspace resolution uses explicit `workspace_path`, supported environment roots, file hints and known/fallback roots. The manager rejects unsuitable roots such as the filesystem root, home directory and known app-host locations. Multi-project callers should supply explicit workspace paths.

Contexts hold database, repository, parser pipeline, resolver and watcher state. Leases prevent eviction during active use. A bounded serial queue orders tool work. Watchers coalesce events, periodically verify content and fall back to polling when watch resources are exhausted. Query dispatch awaits readiness and flushes pending work, then reloads effective policy and checks ownership.

| Current resource setting | Value |
| --- | --- |
| Cached workspaces | 4 |
| Idle expiry | 10 minutes |
| Watch budget | 2,048 |
| Pending watcher paths | 1,000 |
| Event debounce | 300 ms |
| Poll interval | 5 seconds |
| Content verification interval | 60 seconds |
| Source read limit per file | 2 MiB |
| Ingestion batch limits | 50 files / 1 MiB |
| Pending serial queue limit | 50 |
| Shutdown wait setting | 5 seconds |

These are implementation settings, not latency or memory guarantees. Cancellation is checked at cooperative points; it is not atomic rollback or forced termination of every synchronous parse/filesystem operation.

## Revisions and telemetry

Parser/semantic implementation fingerprints include loaded implementation/runtime and grammar assets. Resolution records revision/configuration evidence and observed interpretation inputs. Revision metadata does not establish that another installed process is running this checkout.

Telemetry records request/response sizes, timing, transport status, analysis outcome and selected options. Raw argument payloads, detailed errors and response previews are omitted from default telemetry; `SEPTUM_DEBUG_TELEMETRY=1` enables debug details. This statement concerns telemetry serialization, not a guarantee that all process stderr or client logs are redacted.

## Implementation and regression evidence

- [Configuration](../../src/core/config/loader.ts), [database](../../src/core/database/client.ts)
- [Inventory](../../src/core/resources/source-inventory.ts), [ingestion](../../src/core/ingestion/pipeline.ts), [slice publication](../../src/core/resolver/slice-catalog.ts)
- [Manager](../../src/mcp/workspace-manager.ts), [watcher](../../src/mcp/workspace-watcher.ts), [limits](../../src/core/resources/limits.ts)
- [Fingerprinting](../../src/core/parser/implementation-fingerprint.ts), [telemetry](../../src/core/telemetry/telemetry.ts)
- [Policy ownership](../../tests/unit/policy-ownership.test.ts), [source consistency](../../tests/unit/source-read-consistency.test.ts), [workspace lifecycle](../../tests/unit/memory-workspaces.test.ts), [database corruption](../../tests/unit/database-corruption.test.ts), [observability](../../tests/mcp-observability.test.ts)
