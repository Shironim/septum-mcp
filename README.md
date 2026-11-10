# Septum

> **Architecture boundary guard and codebase intelligence for AI coding agents.**

[![Version: 0.2.2](https://img.shields.io/badge/Version-0.2.2-blue)](package.json)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Septum provides architecture maps, change context, and boundary checks for AI coding agents before and after edits. It indexes source in a local SQLite database (`.septum/septum.db`) and evaluates configured dependency rules and task scope. Results describe detected relationships and analysis limits; application behavior still requires application verification.

Start with the [product requirements and feature inventory](docs/feature/README.md), which serves as the Single Source of Truth (SSOT) for all Septum capabilities, architectures, and hook specifications.

---

## Installation

### Option 1: Standalone Binary (Recommended)

No need to install Bun, Node.js, or package managers. Download and install the prebuilt binary:

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

> **Zero-Install:** You can also run commands directly using `bunx @dimassetoid/septum-mcp <command>`.

---

## Quick Start

### 1. Initialize in Any Project

Run `septum init` from the workspace directory you want Septum to manage:

```bash
septum init
# or zero-install via bunx:
bunx septum init
```

Septum automatically:
1. **Detects Project Structure:** Identifies module boundaries across Monorepos, Laravel, Next.js, NestJS, Express, Fastify, Hono, Elysia, Django, Flask, FastAPI, and Go.
2. **Indexes Codebase AST:** Ingests symbols, interfaces, and dependencies into `.septum/septum.db`.
3. **Scaffolds Agent Configurations:** Sets up MCP servers, skills, and pre-write hooks for supported environments:
   - **Antigravity** (`.gemini/`)
   - **Claude Code** (`.claude/`, `.mcp.json`, `CLAUDE.md`)
   - **Codex** (`.codex/`)
   - **Opencode** (`opencode/`, `opencode.json`)
   - **.agents Standard** (`.agents/`, `AGENTS.md`)

Septum retains twelve semantic adapters: Laravel, Symfony, MCP/CLI, NestJS, Express, Fastify, Hono, Elysia, FastAPI, Django, Flask, and Go. They cover selected static patterns with framework-specific limits; registration does not certify complete framework understanding. Behavioral and migration/Prisma schema enrichment remain available within their declared heuristic limits.

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
*(Or use `"command": "bunx", "args": ["septum", "serve"]` if running without global installation).*

---

## CLI Reference

| Command | Description |
|---|---|
| `septum init [--force]` | Scaffold agent integrations and build initial symbol catalog. `--force` regenerates Septum-managed configs while preserving existing database and user git hooks |
| `septum sync [--json]` | Synchronize AST and update symbol catalog into `.septum/septum.db` (full or incremental) |
| `septum check [--strict] [--staged] [--domain <name>] [--json]` | Verify boundary rules and detect cross-domain or circular dependency violations |
| `septum hook pre-write` | Pre-write guard hook to intercept forbidden cross-domain imports in real time |
| `septum serve` | Start stdio Model Context Protocol (MCP) server |

---

## MCP Tools

All tools provide structured schemas via the Model Context Protocol:

- **Domain Map & Discovery (`septum_map`):**
  - `action: "catalog"`: High-level architecture map and module dependencies (`detail_level: "compact" | "full"`).
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

Send these arguments to `septum_symbol` with an explicit `workspace_path` when needed. Context v2 supports `.ts/.mts/.cts` and selects supporting declarations through bounded local/import bindings. TSX and complete business dependency closure are outside this policy.

Read evidence scope, freshness and omissions before editing. Retrieval is strictly read-only; use impact for potential consumers and application checks for behavior. Budget, paging, source identity and recovery semantics have one owner: the [symbol context contract](docs/feature/symbol-context-contract.md). Per-action requirements are in [septum_symbol](docs/feature/septum-symbol.md).

---

## License

[MIT](LICENSE) © shironim

