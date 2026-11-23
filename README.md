# Septum

> **Local codebase intelligence and architecture boundary guard for AI coding agents.**

[![Version: 0.5.2](https://img.shields.io/badge/Version-0.5.2-blue)](package.json)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Septum is a local static-analysis MCP server and CLI that keeps AI coding agents oriented and within architectural boundaries. Instead of reading entire files or guessing module rules, agents query a local SQLite AST index (`.septum/septum.db`) for compact domain maps, budget-bounded symbol context, static flow slices, and deterministic import/boundary checks before and after edits.

---

## What It Does

- **Domain Map & Discovery (`septum_map`):** Provides a compact navigation catalog of domains, file import relationships, static entrypoints, and index health—and lets you register or update allowed/forbidden domain dependencies.
- **Bounded Symbol Context & Impact (`septum_symbol`):** Locates declarations across the codebase, retrieves bounded implementation context (deep TypeScript reference context within `budget_bytes`, or bounded polyglot source inspection), and reports static dependents and caller hints.
- **Static Flow Tracing (`septum_slice`):** Traces static relationship chains from supported application entrypoints (`query`, `controller_file`, `max_depth`) across layers, showing relationship evidence or `unknown` for each node.
- **Architecture Boundary Guard (`septum_boundary`):** Validates proposed file imports against domain rules before writing (`scope: "file"`), checks staged Git changes before commit (`scope: "staged"`), and audits circular or cross-domain violations (`scope: "domain"`, `scope: "all"`).
- **MCP App UI, Resources & Prompts (`septum_app`, `ui://septum/app.html`):** Ships an interactive MCP App panel (Architecture, Slice, and Boundary views) for compatible hosts, read-only `septum://` workspace resources (`domains`, `health`, `boundaries`, `apps`, `domain/{name}`), and five workflow prompts (`open-apps`, `audit-coupling`, `check-staged`, `plan-refactor`, `trace-feature`).

### Language Support & Analysis Scope

- **AST & Declarations (`web-tree-sitter` + TypeScript compiler fallback):** Partial declaration extraction for TypeScript, JavaScript, PHP, Python, Go, Rust, Java, C#, Ruby, Blade, and embedded scripts in Vue, Astro, and Svelte. TypeScript and TSX files automatically fall back to the TypeScript compiler parser when `tree-sitter-wasms` hits syntax recovery on newer syntax. Deep context (`context_mode: "deep"`) targets `.ts`, `.tsx`, `.mts`, and `.cts` files.
- **Entrypoint Adapters:** Selected patterns in Laravel, Symfony, MCP/CLI, NestJS, Express, Fastify, Hono, Elysia, Next.js App Router, FastAPI, Django, Flask, and Go.
- **Import Resolution:** Supported patterns across JS/TS, PHP, Python manifests/lockfiles, Go workspaces/replacements, Rust Cargo/modules, Ruby literal requires/gems, Java source projects, and C# namespaces/project references.

> **Static Analysis Scope:** Septum evaluates source files and dependency policies statically—it does not execute the target application or establish complete runtime call graphs. Application behavior still requires application tests. See [implemented features](docs/feature/README.md) and [import resolution](docs/feature/import-resolution.md) for full tool contracts and known limits.

---

## Installation

### Option 1: Standalone Binary

Precompiled executables bundle the runtime:

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Shironim/septum-mcp/master/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Shironim/septum-mcp/master/install.ps1 | iex
```

> **Manual Downloads:** Binaries are also available on [GitHub Releases](https://github.com/Shironim/septum-mcp/releases) for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64.exe`.

### Option 2: Via Bun

If you already use [Bun](https://bun.sh):

```bash
bun add -g @dimassetoid/septum-mcp
```

You can also invoke it directly with `bunx @dimassetoid/septum-mcp <command>`.

---

## Quick Start

### 1. Initialize a Workspace

Run `septum init` in your project root:

```bash
septum init
# or via bunx:
bunx @dimassetoid/septum-mcp init
```

Initialization performs three steps:

1. **Infers Project Structure:** Uses supported manifests and directory layouts to propose domain boundaries and dependency policies.
2. **Indexes Supported Source:** Extracts declarations, imports, and static entrypoints into `.septum/septum.db`.
3. **Scaffolds Agent Integrations:** Writes MCP configs, skills, and hook artifacts for supported clients:
   - **Antigravity** (`.gemini/`)
   - **Claude Code** (`.claude/`, `.mcp.json`, `CLAUDE.md`)
   - **Codex** (`.codex/`)
   - **Opencode** (`opencode/`, `opencode.json`)
   - **.agents Standard** (`.agents/`, `AGENTS.md`)

### 2. Manual MCP Client Configuration (Optional)

If your MCP client is not configured via `septum init`, add Septum to `.mcp.json` or `claude_desktop_config.json`:

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
*(Or use `"command": "bunx", "args": ["@dimassetoid/septum-mcp", "serve"]` when invoking through Bun.)*

---

## CLI Reference

| Command | Description |
|---|---|
| `septum init [--force]` | Scaffold agent integrations and build the initial symbol catalog. `--force` regenerates Septum-managed configs while preserving the existing database and user git hooks |
| `septum sync [--json]` | Synchronize AST and update the symbol catalog in `.septum/septum.db` (full or incremental) |
| `septum check [--strict] [--staged] [--json]` | Verify boundary rules and detect cross-domain or circular dependency violations |
| `septum stats [workspace] [--json]` | Summarize recent MCP tool calls, error rates, and latency/size percentiles from `.septum/septum.log` |
| `septum hook pre-write` | Reconstruct supported candidate edits from stdin and evaluate their imports (interception depends on client hook configuration) |
| `septum serve` | Start the stdio Model Context Protocol (MCP) server |

---

## Documentation

- [Implemented Features & Limits](docs/feature/README.md) — Tool behaviors, language coverage, and verification scope
- [MCP Resources, Prompts & Apps](docs/feature/mcp-resources-and-prompts.md) — Workspace resources, workflow playbooks, and the Septum Architecture UI
- [Symbol Context Contract](docs/feature/symbol-context-contract.md) — Deep context selection, byte budgets, and pagination
- [Import Resolution](docs/feature/import-resolution.md) — Supported static targets and unresolved boundaries

---

## License

[MIT](LICENSE) © shironim
