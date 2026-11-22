# Septum MCP: implemented features

This directory documents implemented behavior, tool contracts, and known limitations for version `0.5.0` ([package.json](../../package.json)). Installed binaries or running MCP processes may differ if built from another revision.

Septum indexes selected source declarations, imports, domain ownership and static entrypoints in SQLite. The stdio server exposes four MCP tools, three resources and two prompts. CLI commands initialize and synchronize the index, audit boundaries and run hooks. The index describes static source evidence.

## Feature documents

| Document | Contents |
| --- | --- |
| [Map](septum-map.md) | Navigation catalog, domain registration and topology discovery |
| [Symbol](septum-symbol.md) | Declaration lookup, bounded source inspection and consumer analysis |
| [Deep context](symbol-context-contract.md) | TypeScript reference selection, public contracts and pagination |
| [Slice](septum-slice.md) | Static entrypoint matching and relationship chains |
| [Boundary](septum-boundary.md) | Proposal, workspace, domain and Git-index checks |
| [Import resolution](import-resolution.md) | Language-specific static targets, manifests, project references and uncertainty |
| [Hooks](septum-hooks.md) | Candidate reconstruction, pre-write decisions and background sync |
| [MCP resources and prompts](mcp-resources-and-prompts.md) | Workspace resources, prompt arguments and JSON-RPC responses |
| [Workspace lifecycle](workspace-lifecycle.md) | Policy, database, ingestion, watchers, resource limits and telemetry |

## Entry points

`bun run bin/septum.ts <command>` runs the checkout. The package also declares `septum` and `septum-mcp` executables. A compiled executable can be built through the package build script.

| CLI command | Implemented behavior |
| --- | --- |
| `init` | Discover/configure the workspace, scaffold selected integrations and synchronize the index; `--force` regenerates Septum-owned artifacts |
| `sync` | Synchronize source and static slice catalog; `--json` emits metrics |
| `stats [workspace]` | Summarize recent MCP tool logs with optional `--json` output |
| `check` | Synchronize and audit boundaries; supports `--strict`, `--staged` and `--json` |
| `serve` | Start the stdio MCP server |
| `hook pre-write` | Read a supported JSON edit payload from stdin and evaluate candidate imports |
| `help`, `version` | Show CLI information; no command also shows help |

The package script named `ingest` invokes `sync`; `ingest` is not a CLI subcommand. Canonical MCP names are `septum_map`, `septum_symbol`, `septum_slice` and `septum_boundary`. Argument normalizers accept aliases, but examples here use canonical inputs.

## Reading results

- An import dependency identifies a static import relationship. It is not evidence of a method call.
- A static call site is not proof of runtime execution, dispatch identity or a complete caller set.
- An exact slice match refers to query-to-catalog matching, not execution order.
- `unknown`, `partial`, stale-source diagnostics and omitted counts are material parts of a result.
- A successful MCP transport response can contain an analysis rejection or incomplete result.
- Map uses item limits. Source context uses line limits and can apply a byte budget to source text in automatic mode. Deep context measures the serialized tool response.
- All four MCP tools default to `format: "text"` (compact markdown summary) and accept `format: "json"` for structured JSON payloads. MCP resources always return `application/json`.

Pass `workspace_path` when calling tools across repositories. The server resolves workspace roots, awaits readiness and flushes pending watcher work before indexed queries. An uninitialized workspace can return a map diagnostic or accept domain registration. Resources use the initial workspace and have their own initialization responses.

## Language coverage

[language-capabilities.ts](../../src/core/parser/language-capabilities.ts) registers partial declaration extraction for TypeScript, JavaScript, PHP, Python, Go, Rust, Java, C#, Ruby, Blade and embedded scripts in Vue/Astro/Svelte. Declaration support, import resolution, deep context and caller analysis have different coverage.

Kotlin, Scala and Zig are recognized for unsupported-file diagnostics, with no registered extractor. Rust, Ruby, Java and C# have bounded import resolvers with language-specific limitations; see [import resolution](import-resolution.md). Extractor `is_external` flags do not override the resolver's final relationship evidence. Deep context accepts `.ts`, `.tsx`, `.mts` and `.cts` targets.

## Source and verification owners

Public normalization and validation live in [schemas.ts](../../src/mcp/schemas.ts); MCP dispatch lives in [server.ts](../../src/mcp/server.ts); CLI dispatch lives in [cli/index.ts](../../src/cli/index.ts). Each feature document links its implementation and regression tests.

Feature behavior is backed by source inspection, unit tests, and targeted handler fixtures, which do not certify installed-binary parity, live client hook interception, or every framework syntax. Known gaps are noted in each document where they affect behavior.
