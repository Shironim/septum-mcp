# MCP resources and prompts

The stdio server advertises `resources` and `prompts` during `initialize`, alongside `tools`. Clients can discover these features independently of `tools/list`.

## Resources

`resources/list` returns three fixed URIs. `resources/templates/list` advertises `septum://domain/{name}`, a compact domain view using the same indexed navigation as `septum_map`. The template reads the server’s initial workspace. `resources/read` takes a URI and returns a `contents` entry with the URI, `mimeType: "application/json"` and JSON serialized as `text`.

| URI | Data | Workspace access |
| --- | --- | --- |
| `septum://domains` | Compact domain catalog from the same handler as `septum_map` | Acquires a workspace context, checks it and reads the catalog |
| `septum://health` | Recorded sync status, last sync, indexed counts and watcher state for an active context | Reads the existing context without opening or refreshing the index or extending the context's lifetime |
| `septum://boundaries` | Static audit from the same handler as `septum_boundary` with `scope: "all"` | Acquires a workspace context, checks it and runs the audit |

All three refer to the server's initial workspace. Passing `workspace_path` to a tool does not change the resource target. To inspect another workspace, use the tools with its explicit path. See [workspace lifecycle](workspace-lifecycle.md) for synchronization and workspace selection.

For health, a workspace with an initialization marker and no active context returns `inactive`. An uninitialized workspace returns `not_indexed`. Domain and boundary resources return a `not_indexed` JSON body when the workspace is uninitialized. Otherwise they wait for readiness, flush pending watcher work, reload policy and use the same queue as tool requests. An unknown URI returns JSON-RPC error `-32002` with `data.uri`. A failure during preparation, such as malformed policy JSON, can return an internal error.

## Prompts

`prompts/list` returns prompt names and their arguments. `prompts/get` renders the selected prompt as a text message. The host decides how to present the prompts and when to call the tools described by the message.

| Prompt | Arguments | Instructions returned |
| --- | --- | --- |
| `septum-pre-edit-check` | Required nonblank `target`, a symbol name or file path | Locate the target, inspect context and potential callers, then evaluate proposed imports |
| `septum-architecture-audit` | Optional nonblank `workspace_path` and `domain` | Request a compact map and a boundary audit using the same workspace and domain. Without a domain the audit uses `scope: "all"` |

An unknown prompt name, a missing or blank pre-edit target, or invalid architecture-audit arguments return JSON-RPC error `-32602`.

## Implementation and tests

- [Server handlers](../../src/mcp/server.ts) and [resource and prompt implementations](../../src/mcp/resources-and-prompts.ts)
- [Workspace preparation](../../src/mcp/workspace-manager.ts) and [stdio integration tests](../../tests/integration/mcp-reliability.py)
