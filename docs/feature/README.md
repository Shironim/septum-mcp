# Septum MCP: implemented features

This directory describes the source checkout reviewed on 2026-11-14. The package declares version `0.3.0` in [package.json](../../package.json). It documents implemented behavior and current limitations; it does not establish which revision an installed binary or running MCP process has loaded.

Septum indexes selected source declarations, imports, domain ownership and static entrypoints in SQLite. It exposes four MCP tools over stdio and CLI commands for initialization, synchronization, boundary checks and hook execution. It does not execute the application being analyzed or establish complete runtime call graphs.

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
| [Workspace lifecycle](workspace-lifecycle.md) | Policy, database, ingestion, watchers, resource limits and telemetry |

## Entry points

`bun run bin/septum.ts <command>` runs the checkout. The package also declares `septum` and `septum-mcp` executables. A compiled executable can be built through the package build script.

| CLI command | Implemented behavior |
| --- | --- |
| `init` | Discover/configure the workspace, scaffold selected integrations and synchronize the index; `--force` regenerates Septum-owned artifacts |
| `sync` | Synchronize source and static slice catalog; `--json` emits metrics |
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
- Limits differ by operation: map uses item caps, source context uses line limits, and deep context uses a serialized byte budget.

Use `workspace_path` explicitly when working across repositories. The server resolves workspace roots, awaits workspace readiness and flushes pending watcher work before dispatch. An uninitialized workspace receives a map diagnostic; other operations are rejected except domain registration. These checks do not eliminate filesystem-event latency.

## Language coverage

[language-capabilities.ts](../../src/core/parser/language-capabilities.ts) registers partial declaration extraction for TypeScript, JavaScript, PHP, Python, Go, Rust, Java, C#, Ruby, Blade and embedded scripts in Vue/Astro/Svelte. Declaration support, import resolution, deep context and caller analysis have different coverage.

Kotlin, Scala and Zig are recognized for unsupported-file diagnostics, with no registered extractor. Rust, Ruby, Java and C# have bounded import resolvers with language-specific limitations; see [import resolution](import-resolution.md). Extractor `is_external` flags do not override the resolver's final relationship evidence. Deep context accepts only `.ts`, `.mts` and `.cts` targets.

## Source and verification owners

Public normalization and validation live in [schemas.ts](../../src/mcp/schemas.ts); MCP dispatch lives in [server.ts](../../src/mcp/server.ts); CLI dispatch lives in [cli/index.ts](../../src/cli/index.ts). Each feature document links its implementation and regression tests.

The rewrite was checked against source, the local unit suite and targeted handler fixtures. Those checks do not certify installed-binary parity, live harness interception or every framework syntax. Known implementation gaps are documented where they affect behavior.
