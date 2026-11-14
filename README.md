# Septum

> **Architecture boundary guard and codebase intelligence for AI coding agents.**

[![Version: 0.2.2](https://img.shields.io/badge/Version-0.2.2-blue)](package.json)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Septum provides architecture maps, declaration context, and boundary checks for AI coding agents before and after edits. It indexes source in a local SQLite database and evaluates configured domain dependency rules. Results describe detected relationships and analysis limits; application behavior still requires application verification.

Start with the [implemented feature documentation](docs/feature/README.md), which describes the reviewed source checkout, tool behavior and known limits. Installed binaries and running MCP processes can use a different revision.

---

## Installation

### Option 1: Standalone Binary

The standalone executable bundles its runtime. The installation scripts select a release executable for the platform:

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Shironim/septum-mcp/master/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Shironim/septum-mcp/master/install.ps1 | iex
```

> **Manual Downloads:** Precompiled binaries are also available on [GitHub Releases](https://github.com/Shironim/septum-mcp/releases) for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64.exe`.

### Option 2: Via Bun

If you already use [Bun](https://bun.sh):

```bash
bun add -g @dimassetoid/septum-mcp
```

You can invoke the package with `bunx @dimassetoid/septum-mcp <command>`.

---

## Quick Start

### 1. Initialize a Workspace

Run `septum init` from the workspace directory you want Septum to manage:

```bash
septum init
# or via bunx:
bunx @dimassetoid/septum-mcp init
```

Initialization:

1. **Infers Project Structure:** Uses supported manifests and directory layouts to propose domains and dependency policies.
2. **Indexes Supported Source:** Stores extracted declarations, imports and static entrypoints in the configured database; the default is `.septum/septum.db`.
3. **Scaffolds Selected Agent Configurations:** Writes MCP configuration, skills and hook artifacts for supported environments:
   - **Antigravity** (`.gemini/`)
   - **Claude Code** (`.claude/`, `.mcp.json`, `CLAUDE.md`)
   - **Codex** (`.codex/`)
   - **Opencode** (`opencode/`, `opencode.json`)
   - **.agents Standard** (`.agents/`, `AGENTS.md`)

Semantic adapters cover selected patterns in Laravel, Symfony, MCP/CLI, NestJS, Express, Fastify, Hono, Elysia, FastAPI, Django, Flask and Go. Their applicability and extraction results depend on repository syntax and configuration.

Import resolution includes supported Python manifests/lockfiles, Go workspaces/replacements, Rust Cargo/modules, Ruby literal requires/gems, Java source projects and C# namespaces/project references. See [import resolution](docs/feature/import-resolution.md) for supported cases and unresolved boundaries.

Detection and scaffolding do not certify every framework pattern or active client hook. See the [feature specifications and architecture contracts](docs/feature/README.md) for full scope and technical details.

### 2. Manual MCP Client Configuration (Optional)

If your MCP client is not configured via `septum init`, add Septum to your MCP configuration (`.mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "septum": {
      "command": "septum",
      "args": ["serve"]
    }
  }
}
```
*(Or use `"command": "bunx", "args": ["@dimassetoid/septum-mcp", "serve"]` when invoking the package through Bun).*

---

## CLI Reference

| Command | Description |
|---|---|
| `septum init [--force]` | Scaffold agent integrations and build initial symbol catalog. `--force` regenerates Septum-managed configs while preserving existing database and user git hooks |
| `septum sync [--json]` | Synchronize AST and update symbol catalog into `.septum/septum.db` (full or incremental) |
| `septum check [--strict] [--staged] [--json]` | Verify boundary rules and detect cross-domain or circular dependency violations |
| `septum hook pre-write` | Reconstruct supported candidate edits from stdin and evaluate their imports; interception depends on the client and hook configuration |
| `septum serve` | Start stdio Model Context Protocol (MCP) server |

---

## MCP Tools

All tools provide structured schemas via the Model Context Protocol:

- **Domain Map & Discovery (`septum_map`):**
  - `action: "catalog"`: Navigation map (`navigation/v1`): domain/file import paths, static entrypoints, health and targeted next steps. `full` expands navigation; inspect signatures and source with `septum_symbol`.
  - `action: "register"`: Register or update domain boundaries with allowed and forbidden dependencies.
- **Symbol Inspection & Impact Analysis (`septum_symbol`):**
  - `action: "locate"`: Search and find symbols across the codebase.
  - `action: "context"` (accepts `action: "inspect"` as alias): Retrieve declaration implementation and supporting declarations (deep TypeScript context retrieval within `budget_bytes`, or bounded polyglot source inspection).
  - `action: "impact"`: Inspect static dependent/caller hints. Imports are reported separately and do not prove executed calls or a complete runtime blast radius.
- **Execution Flow Tracer (`septum_slice`):**
  - Navigate static context across application layers from supported entrypoints (`query`, `controller_file`, `max_depth`). Each node shows its relationship evidence or `unknown`.
- **Dependency & Boundary Validator (`septum_boundary`):**
  - Validate proposed file imports against defined architectural rules (`scope: "file"`).
  - Check staged files in the Git index before commit (`scope: "staged"`).
  - Audit circular dependencies and boundary violations for a specific domain (`scope: "domain"`) or the entire codebase (`scope: "all"`).

---

## Select context before editing

Locate a declaration, select its returned `symbol_ref` when names are ambiguous, then request context:

```json
{"action":"context","query":"submit","file_path":"src/submit.ts","budget_bytes":65536}
```

Send these arguments to `septum_symbol` with an explicit `workspace_path` when needed. Context v4 supports `.ts/.mts/.cts` and selects supporting declarations through bounded local/import bindings. Set `context_mode: "deep"` explicitly for this policy, or `context_mode: "source"` for bounded source inspection. Omission preserves legacy automatic selection; responses identify the selected mode. TSX and complete business dependency closure are outside the deep-context policy.

Read evidence scope, freshness and omissions before editing. Context inspection returns source/contracts; lookup and server freshness guards can synchronize the local index. Use impact for potential consumers and application checks for behavior. Budget, paging, source identity and recovery semantics have one owner: the [symbol context contract](docs/feature/symbol-context-contract.md). Per-action requirements are in [septum_symbol](docs/feature/septum-symbol.md).

---

## License

[MIT](LICENSE) © shironim

