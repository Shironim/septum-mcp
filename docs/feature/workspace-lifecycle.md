# Workspace lifecycle and stored state

## Policy and database selection

`ConfigLoader.load()` reads `septum.config.json` when present; otherwise it reads policy/settings from SQLite or defaults. Loading policy does not perform topology discovery or initialize an index.

The file owns policy when present. Otherwise SQLite owns registered domains/settings. `resolveDatabasePath()` resolves relative `settings.db_path` from the workspace and preserves absolute paths and `:memory:`. The default path is `.septum/septum.db`.

The configuration schema defaults enforcement to `warn`. Its default ignore patterns include `.septum/**`. The file loader uses the same schema for file configuration and the default configuration.

Custom paths are supported by command/workspace database resolution; MCP initialization recognition and generated hook wrappers both accept `septum.config.json` in addition to `.septum/septum.db`. See [hooks](septum-hooks.md).

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

Contexts hold database, repository, parser pipeline, resolver and watcher state. Leases prevent eviction during active use. A bounded serial queue orders tool work. Watchers coalesce events, periodically verify content and fall back to polling when watch resources are exhausted. Query dispatch awaits readiness and flushes pending work, then reloads effective policy and checks ownership in the serial queue immediately before executing the tool.

Tool calls that provide an MCP progress token receive notifications for preparation, index freshness checks, and execution. A cancelled request can stop waiting for shared initialization or reconciliation. The workspace retains ownership of that work until it settles or the workspace closes.

The initial workspace comes from `SEPTUM_WORKSPACE_ROOT`, then `WORKSPACE_ROOT`, or the process's current directory when it has a project marker. Septum validates this root before opening stdio. Index-dependent requests await workspace readiness. [MCP resources](mcp-resources-and-prompts.md) use that workspace. Tool calls can select other roots without changing the resource target.

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
