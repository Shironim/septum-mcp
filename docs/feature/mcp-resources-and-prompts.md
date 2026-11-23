# MCP resources and prompts

The stdio server advertises `resources` and `prompts` during `initialize`, alongside `tools`. Clients can discover these features independently of `tools/list`.

## Resources

`resources/list` returns five fixed URIs. `resources/templates/list` advertises `septum://domain/{name}`, a compact domain view using the same indexed navigation as `septum_map`. `resources/read` takes a URI and returns a `contents` entry with the URI, its `mimeType` (`application/json` for data resources, `text/html;profile=mcp-app` for the UI resource) and the payload serialized as `text`.

| URI | MIME type | Data | Workspace access |
| --- | --- | --- | --- |
| `septum://domains` | `application/json` | Compact domain catalog from the same handler as `septum_map` | Acquires a workspace context, checks it and reads the catalog |
| `septum://health` | `application/json` | Recorded sync status, last sync, indexed counts and watcher state for an active context | Reads the existing context without opening or refreshing the index or extending the context's lifetime |
| `septum://boundaries` | `application/json` | Static audit from the same handler as `septum_boundary` with `scope: "all"` | Acquires a workspace context, checks it and runs the audit |
| `septum://apps` | `application/json` | MCP App entrypoint (`septum_app`), active coverage/partial-index diagnostics and next actions | Peeks active context and health without triggering ingestion |
| `ui://septum/app.html` | `text/html;profile=mcp-app` | Bundled interactive MCP App UI for architecture navigation, slices and boundary audits | Serves the built HTML bundle (`dist/mcp-app.html`) or a fallback status page if unbuilt |

Data resources default to the most recently acquired workspace and fall back to the server's initial workspace. Append `?workspace=` followed by a URL-encoded workspace path to select a specific workspace. See [workspace lifecycle](workspace-lifecycle.md) for synchronization and workspace selection.

For `septum://health`, a workspace with an initialization marker and no active context returns `inactive`. An uninitialized workspace returns `not_indexed`. Domain and boundary resources return a `not_indexed` JSON body when the workspace is uninitialized. Otherwise they wait for readiness, flush pending watcher work, reload policy and run through the workspace queue. An unknown URI returns JSON-RPC error `-32002` with `data.uri`. A failure during preparation, such as malformed policy JSON, returns an internal error.

## Opening the panel

Hosts that support Septum’s app entrypoint can open the panel through their app controls. The `septum_app` tool carries the UI resource metadata and has app-only visibility. `septum_map`, `septum_slice`, and `septum_boundary` provide analysis data. On an uninitialized workspace, the app entrypoint returns the same `NOT_INDEXED` catalog diagnostic as `septum_map`.

## Prompts

`prompts/list` returns five workflow playbooks and their arguments. `prompts/get` renders the selected prompt as a user text message with step-by-step tool instructions.

| Prompt | Arguments | Instructions returned |
| --- | --- | --- |
| `open-apps` | Optional `workspace_path` | Open Septum Architecture through the host’s app controls if available. Run `septum_map` to inspect coverage and report next steps. Read `septum://apps` for partial-file samples when supported. |
| `audit-coupling` | Optional `domain`, `workspace_path` | Run `septum_map` and `septum_boundary` (`scope: "domain"` or `"all"`), then rank circular dependencies, forbidden imports with `file:line`, and high fan-out domains |
| `check-staged` | Optional `workspace_path` | Run `septum_boundary` with `scope: "staged"` before commit, list any violations with `file:line` and rule, and propose refactors |
| `plan-refactor` | Optional `target`, `workspace_path` | Run `septum_symbol` (`action: "impact"`) on the target symbol or file, inspect domain dependency policies via `septum_map`, and outline a leaf-to-core migration order |
| `trace-feature` | Optional `query`, `workspace_path` | Trace an entrypoint with `septum_slice` (or discover entrypoints first with `septum_map`) and summarize each stage with `file:line` and any skipped layers or unresolved hops |

An unknown prompt name returns JSON-RPC error `-32602`.

## Implementation and tests

- [Server handlers](../../src/mcp/server.ts), [resource implementations](../../src/mcp/resources-and-prompts.ts) and [workflow playbooks](../../src/mcp/workflow-playbooks.ts)
- [Workspace preparation](../../src/mcp/workspace-manager.ts) and [stdio integration tests](../../tests/integration/mcp-reliability.py)
