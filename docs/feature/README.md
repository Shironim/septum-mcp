# Septum SSOT — Feature & Architecture Catalog

Septum is a backend structural intelligence engine powered by **Tree-Sitter AST (Abstract Syntax Tree)** and an embedded **SQLite (`.septum/septum.db`)** database. Septum is purposefully designed for AI Coding Agents to navigate, comprehend architecture, trace execution flows, and refactor multi-language backend code without relying on brute-force text searches (*grep*) or token-heavy full-file reads.

---

## 1. Philosophy & Problems Solved

In medium-to-large-scale backend engineering:
1. **Language & Framework Divergence:** Modern backends span multiple languages (TypeScript, PHP, Python, Go, Rust, Java, C#) across various frameworks (NestJS, Laravel, FastAPI, Gin, Symfony, Express). Conventional AI agents often misinterpret architecture because they rely on raw text regex search.
2. **Token Bloat & Context Costs:** Reading thousands of lines in controller or service files simply to inspect a method signature or DTO contract consumes 80–90% of an AI agent's context window.
3. **Blast Radius Blindness:** AI agents frequently alter function signatures without knowing which services invoke them across the codebase, triggering regressions and runtime bugs.
4. **Architectural Drift:** AI agents frequently introduce forbidden cross-domain imports (e.g., billing directly importing ordering) or introduce circular dependencies.

Septum resolves these issues by building a real-time **Single Source of Truth (SSOT)** for dependency graphs, symbol tables, domain topologies, and vertical execution slices.

---

## 2. Feature SSOT Directory

Every document in this `docs/feature/` directory represents a definitive **Single Source of Truth (SSOT)** for a core Septum capability:

| SSOT Document | Feature / Component | Primary Scope & Focus |
|---|---|---|
| [septum-slice.md](./septum-slice.md) | `septum_slice` | **Vertical Execution Chain Tracer:** Traces end-to-end execution flow from Route Ingress, Middleware, Validation DTO, Controller, Service, down to Database/Entity across 12 backend frameworks plus a generic call-graph fallback. Supports HTTP endpoints, CLI Commands, Queue Jobs, and Domain Events. |
| [septum-symbol.md](./septum-symbol.md) | `septum_symbol` | **AST Symbol Intelligence:** Sub-actions `locate` (fuzzy Damerau-Levenshtein search, error log / stack-trace parser), `context` (bounded 16 KB AST slice, anti-hollow slicing via 1-hop delegator expansion, DTO extraction), and `impact` (blast radius & backward inbound callers). |
| [septum-map.md](./septum-map.md) | `septum_map` | **Navigation & Domain Registration:** Domain/file import paths, static entrypoints, index health and targeted next steps (`navigation/v1`); symbol inspection supplies depth. |
| [septum-boundary.md](./septum-boundary.md) | `septum_boundary` | **Architectural Boundary Guard:** Enforces bounded-context rules (`forbidden_dependency`, `disallowed_dependency`, `circular_dependency`, `unmapped_domain`), smart type-only import erasure, pre-flight import proposal simulations, and git-staged audits. |
| [septum-hooks.md](./septum-hooks.md) | Septum Hooks System | **Real-Time Guard & Auto-Sync:** Pre-Write Hook (`PreToolUse`) for in-memory interception and blocking of illegal mutations before touching disk, and Post-Write Hook (`PostToolUse`) for non-blocking background incremental synchronization. |
| [workspace-lifecycle.md](./workspace-lifecycle.md) | Lifecycle & Invalidation | **Database SSOT & Hashing Engine:** Internal SQLite schema, transitive invalidation for type files (`types.ts`) and barrel files (`index.ts`), and global configuration revision tracking (*Config Fingerprint*). |
| [symbol-context-contract.md](./symbol-context-contract.md) | Context Contract Host | **In-Memory TypeScript Compiler Host:** Technical specifications for AST loading and public DTO interface contract projection without `node_modules` overhead. |

---

## 3. MCP Tool Routing Matrix for AI Agents

| AI Agent Scenario | MCP Tool Call | Advantage vs Conventional Approach |
|---|---|---|
| Understand project structure, domain boundaries, and file inventory | `septum_map({ action: "catalog" })` | Delivers an instant macro architectural map without repeated `ls` or `find` calls. |
| Trace static relationships around an endpoint | `septum_slice({ query: "POST /path" })` | Returns supported route, DTO, handler and persistence relationships with evidence limits; it does not prove a complete runtime execution chain. |
| Locate exact file coordinates and line numbers of a function/class | `septum_symbol({ action: "locate", query: "..." })` | Pinpoints precise coordinates via Damerau-Levenshtein fuzzy matching without reading entire files. |
| Inspect implementation logic, parameters, or return types | `septum_symbol({ action: "context", query: "..." })` | Returns a bounded AST slice and DTOs without overwhelming the context window. |
| Investigate potential consumers before refactoring | `septum_symbol({ action: "impact", query: "..." })` | Separates import dependencies from inferred caller hints; coverage remains partial and risk is advisory. |
| Validate whether a new import violates architectural rules | `septum_boundary({ file_path: "...", proposed_imports: [...] })` | Simulates architectural compliance in pre-flight mode before saving changes to disk. |
| Audit architectural compliance before committing | `septum_boundary({ scope: "staged" })` | Ensures staged git files are free of circular dependencies and forbidden imports. |
